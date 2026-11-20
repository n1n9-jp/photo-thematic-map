import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';

// 計測用。環境変数 PTM_MEASURE=1 を付けたときだけ実行する（ネットワークと時間を使うため）。
//   PTM_MEASURE=1 npx playwright test tests/e2e/plateau-memory.spec.ts --trace off
// 本編の場面の順にカメラを移し、場面ごとの JS ヒープ・テクスチャ数・タイル数を
// screenshots/plateau-memory.json に書き出す。画面は screenshots/plateau-memory-<番号>-<場面>.png。
test.skip(!process.env.PTM_MEASURE, '計測用（PTM_MEASURE=1 のときだけ実行）');
// PTM_MEASURE_MOBILE=1 なら、スマートフォンの画面（短辺 390px）で計測する（スマートフォン向けのメモリの上限が選ばれる）
const MOBILE = Boolean(process.env.PTM_MEASURE_MOBILE);
if (MOBILE) test.use({ viewport: { width: 390, height: 844 } });
const OUT = MOBILE ? 'plateau-memory-mobile' : 'plateau-memory';
test.setTimeout(1_500_000);

const SCENES = [
  'akihabara-ground',
  'akihabara-sky',
  'overview',
  'tokyo-marunouchi',
  'kokyo-gaien',
  'tokyo-front',
  'akihabara-ground',
] as const;

type Stats = Record<string, number | boolean>;

/** このテストのブラウザ（worker の子孫のプロセス）のレンダラー・GPU プロセスの RSS(MB)。 */
function processRssMB(rootPid: number): { rendererMB: number; gpuMB: number } {
  const rows = execSync('ps -eo pid,ppid,rss,args', { encoding: 'utf8' }).split('\n').slice(1);
  const procs = rows
    .map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), args: m[4] ?? '' }));
  // ブラウザの子孫のプロセスだけを数える
  const mine = new Set<number>([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of procs) {
      if (mine.has(p.ppid) && !mine.has(p.pid)) {
        mine.add(p.pid);
        changed = true;
      }
    }
  }
  const sum = (type: string): number =>
    Math.round(procs.filter((p) => mine.has(p.pid) && p.args.includes(`--type=${type}`)).reduce((a, p) => a + p.rss, 0) / 1024);
  return { rendererMB: sum('renderer'), gpuMB: sum('gpu-process') };
}

/** 建物の LRU キャッシュの推定バイト数(MB)。修正前は全層で 1 つのキャッシュを共有している。 */
async function buildingCacheMB(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stage = (window as unknown as { __PTM_STAGE__: Record<string, { tiles: { lruCache: { cachedBytes: number } }[] }> }).__PTM_STAGE__;
    const caches = new Set<{ cachedBytes: number }>();
    for (const layer of [stage.buildings, stage.outerBuildings]) for (const t of layer?.tiles ?? []) caches.add(t.lruCache);
    let bytes = 0;
    for (const c of caches) bytes += c.cachedBytes;
    return Math.round(bytes / 1e6);
  });
}

async function readStats(page: Page): Promise<Stats> {
  return page.evaluate(() => (window as unknown as { __PTM_STATS__: () => Stats }).__PTM_STATS__());
}

/** 読み込み中でない状態が 3 回続くまで（最大 maxMs）待つ。 */
async function waitSettled(page: Page, maxMs: number): Promise<void> {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < maxMs && quiet < 3) {
    await page.waitForTimeout(1000);
    quiet = (await readStats(page)).loading ? 0 : quiet + 1;
  }
}

test('場面を移したときのメモリ', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  // 建物はテクスチャなしの LOD2 だけを読む（detail=0：テクスチャ付きの円の半径 0）
  await page.goto('/demos/plateau.html?outer=2500&detail=0');
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 300_000 });

  const rows: Record<string, unknown>[] = [];
  for (const [i, scene] of SCENES.entries()) {
    await page.evaluate((s) => (window as unknown as { __PTM_GOTO__: (n: string) => Promise<void> }).__PTM_GOTO__(s), scene);
    await waitSettled(page, 120_000);
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number };
    const stats = await readStats(page);
    const row = {
      step: i + 1,
      scene,
      heapMB: Math.round(heap.usedSize / 1e6),
      ...processRssMB(process.pid),
      buildingCacheMB: await buildingCacheMB(page),
      ...stats,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    await page.screenshot({ path: `screenshots/${OUT}-${i + 1}-${scene}.png` });
  }
  await writeFile(`screenshots/${OUT}.json`, JSON.stringify(rows, null, 2));
});
