import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';
import type { LaunchOptions, Page } from '@playwright/test';
import { SCRIPT } from '../../src/story/content/script';

// 計測用。環境変数 PTM_MEASURE=1 を付けたときだけ実行する（PLATEAU から直接読む経路も測るので、ネットワークと時間を使う）。
//   PTM_MEASURE=1 npx playwright test tests/e2e/main-memory.spec.ts --trace off
// 本編の場面を順に巡り、場面ごとの JS ヒープとレンダラー・GPU プロセスの RSS を、変換済みの建物（既定）と
// 直接読む経路（?buildings=live）で測って screenshots/main-memory.json に書き出す（plateau-memory.spec.ts と同じ考え方）。
// 経路ごとにブラウザを起動し直す（GPU プロセスを共有しないため）。
test.skip(!process.env.PTM_MEASURE, '計測用（PTM_MEASURE=1 のときだけ実行）');
test.setTimeout(3_000_000);

const SETTLE_TIMEOUT_MS = 420_000;

/** ブラウザ（pid）の子孫のレンダラー・GPU プロセスの RSS(MB)。 */
function processRssMB(rootPid: number): { rendererMB: number; gpuMB: number } {
  const rows = execSync('ps -eo pid,ppid,rss,args', { encoding: 'utf8' }).split('\n').slice(1);
  const procs = rows
    .map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), args: m[4] ?? '' }));
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

async function goToScene(page: Page, i: number): Promise<void> {
  await page.evaluate((i) => {
    const api = window.__MAIN__!;
    const hold = api.holds()[i] ?? 0.4;
    window.scrollTo({ top: api.scrollYFor(i, hold * (i === 1 ? 0.95 : 0.5)), behavior: 'instant' });
  }, i);
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage)).toBe(i);
  await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
}

test('本編の場面を巡ったときのメモリ（変換済み / 直接読む経路）', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const use = testInfo.project.use;
  const rows: Record<string, unknown>[] = [];
  for (const mode of ['baked', 'live'] as const) {
    const browser = await chromium.launch(use.launchOptions as LaunchOptions);
    const page = await browser.newPage({ viewport: use.viewport ?? { width: 1280, height: 720 }, baseURL: use.baseURL });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(mode === 'live' ? '/?buildings=live' : '/');
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });
    for (let i = 0; i < SCRIPT.length; i++) {
      await goToScene(page, i);
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
      const city = await page.evaluate(() => window.__MAIN__!.status().city);
      const row = {
        mode,
        scene: i + 1,
        id: SCRIPT[i]!.id,
        heapMB: Math.round(heap.usedSize / 1e6),
        // このテストのプロセスの子孫（いま起動しているブラウザ 1 つ）
        ...processRssMB(process.pid),
        bakedTriangles: city.baked?.triangles ?? null,
        wards: city.wards,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    await browser.close();
  }
  mkdirSync('screenshots', { recursive: true });
  writeFileSync('screenshots/main-memory.json', JSON.stringify(rows, null, 2));
});
