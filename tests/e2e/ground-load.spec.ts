/**
 * 本編: 地面の航空写真の読み込み量（転送量）を、場面ごと・ズームレベル別・「場面が落ち着いた時点で表示に使われているか」別に測る。
 * PC 幅（1280×800）とスマートフォン幅（390×844。`plateauMemoryBudget()` が小さい端末と判定する画面の大きさ）で測り、
 * `screenshots/ground-load/<label>-<pc|mobile>.json` に書き出す。場面1・2・5・6 の落ち着いた時点のスクリーンショットも保存する。
 *
 * - 環境変数 `GROUND_LOAD_LABEL`（既定 'after'）: 出力ファイルの名前の頭（対策の前後の比較用）。
 * - 環境変数 `GROUND_LOAD_QUERY`（既定 ''）: 本編の URL のクエリ（例 '?ortho=gsi' で国土地理院の写真に切り替える）。
 * - 環境変数 `GROUND_LOAD_SCENES`（既定 8）: 測る場面の数（先頭から）。
 * 既定の設定（クエリなし）では、場面1が出そろうまでの航空写真の転送量の上限を検査する。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { SCRIPT } from '../../src/story/content/script';

test.setTimeout(7_200_000);
// PC 幅とスマートフォン幅を並行して測る
test.describe.configure({ mode: 'parallel' });

const SETTLE_TIMEOUT_MS = 1_800_000;
const LABEL = process.env.GROUND_LOAD_LABEL ?? 'after';
const QUERY = process.env.GROUND_LOAD_QUERY ?? '';
const SCENES = Math.min(Number(process.env.GROUND_LOAD_SCENES ?? SCRIPT.length) || SCRIPT.length, SCRIPT.length);
const SHOT_SCENES = new Set([1, 2, 5, 6]);

/**
 * 場面1が出そろうまでの航空写真の転送量の上限(byte)。対策後に達した値（PC 6.65MB・スマートフォン 4.13MB）に
 * 2 割の余裕を足した値。対策前は PC 26.3MB・スマートフォン 15.0MB だった。
 */
const SCENE1_ORTHO_LIMIT = { pc: 8.0e6, mobile: 5.0e6 } as const;

const VIEWPORTS = {
  pc: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

/** 航空写真のタイルの URL なら [z, x, y]。PLATEAU-Ortho と国土地理院の写真（seamlessphoto）。 */
function orthoTile(url: string): [number, number, number] | null {
  const m = /(?:plateauview\.mlit\.go\.jp\/tiles\/[^/]+|cyberjapandata\.gsi\.go\.jp\/xyz\/seamlessphoto)\/(\d+)\/(\d+)\/(\d+)\.(?:png|jpg)/.exec(url);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

interface TileLoad {
  key: string;
  z: number;
  bytes: number;
  /** 読み込んだ場面（1 始まり）。 */
  scene: number;
}

interface SceneRow {
  scene: number;
  id: string;
  settleMs: number;
  /** この場面で読んだ航空写真の枚数と転送量。 */
  tiles: number;
  bytes: number;
  /** そのうち、落ち着いた時点で表示に使われているもの。 */
  shownTiles: number;
  shownBytes: number;
  /** ズームごとの [枚数, 転送量, 表示に使われている枚数, その転送量]。 */
  byZoom: Record<string, [number, number, number, number]>;
  /** 標高タイルの転送量。 */
  elevationBytes: number;
  /** 一度解放したタイルを取り直した転送量（tiles・bytes には含めない）。 */
  refetchBytes: number;
  /** 落ち着いた時点で表示しているタイルの数（ズームごと）。 */
  visibleByZoom: Record<string, number>;
}

async function goToScene(page: Page, i: number, holdFraction: number): Promise<void> {
  await page.evaluate(
    ([i, f]) => {
      const api = window.__MAIN__!;
      const hold = api.holds()[i] ?? 0.4;
      window.scrollTo({ top: api.scrollYFor(i, hold * f), behavior: 'instant' });
    },
    [i, holdFraction] as const,
  );
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage), { timeout: 120_000 }).toBe(i);
  await expect
    .poll(() => page.evaluate(([i, f]) => Math.abs(window.__MAIN__!.getState().progress - (window.__MAIN__!.holds()[i] ?? 0.4) * f), [i, holdFraction] as const), {
      timeout: 60_000,
    })
    .toBeLessThan(0.01);
  await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
}

async function measure(browser: Browser, baseURL: string, name: ViewportName): Promise<SceneRow[]> {
  const vp = VIEWPORTS[name];
  // スマートフォン幅では screen も同じ大きさにする（`isSmallDevice()` は画面の短辺で判定する）
  const context = await browser.newContext({ viewport: vp, screen: vp, baseURL, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = collectErrors(page);
  let scene = 1;
  const loads: TileLoad[] = [];
  const seen = new Set<string>();
  let elevationBytes = 0;
  let refetched = 0;
  /** 解放したタイルを取り直した転送量（場面ごと。ブラウザのキャッシュから返ると小さい）。 */
  const refetchBytes: number[] = [];
  page.on('requestfinished', (req) => {
    const url = req.url();
    const t = orthoTile(url);
    const at = scene;
    void req
      .sizes()
      .then((s) => {
        const bytes = s.responseBodySize + s.responseHeadersSize;
        if (t) {
          const key = t.join('/');
          if (seen.has(key)) {
            refetched++;
            refetchBytes[at] = (refetchBytes[at] ?? 0) + bytes;
            return;
          }
          seen.add(key);
          loads.push({ key, z: t[0], bytes, scene: at });
        } else if (/cyberjapandata\.gsi\.go\.jp\/xyz\/dem/.test(url)) {
          elevationBytes += bytes;
        }
      })
      .catch(() => undefined);
  });

  const tOpen = Date.now();
  await page.goto(`/${QUERY}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 180_000 });
  const rows: SceneRow[] = [];
  let elevBefore = 0;
  for (let i = 0; i < SCENES; i++) {
    scene = i + 1;
    const t0 = Date.now();
    await goToScene(page, i, SCRIPT[i]!.id === 'akihabara-462' ? 0.95 : 0.5);
    const settleMs = Date.now() - (i === 0 ? tOpen : t0);
    // 応答の大きさは非同期に数えるので、少し待ってから読む
    await page.waitForTimeout(800);
    const tiles = await page.evaluate(() =>
      (window as unknown as { __PTM_APP__: { city: { ground: { debugTiles(): { z: number; x: number; y: number; visible: boolean }[] } } } }).__PTM_APP__.city.ground.debugTiles(),
    );
    const shown = new Set(tiles.filter((t) => t.visible).map((t) => `${t.z}/${t.x}/${t.y}`));
    const visibleByZoom: Record<string, number> = {};
    for (const t of tiles) if (t.visible) visibleByZoom[t.z] = (visibleByZoom[t.z] ?? 0) + 1;
    const mine = loads.filter((l) => l.scene === scene);
    const byZoom: Record<string, [number, number, number, number]> = {};
    for (const l of mine) {
      const z = (byZoom[l.z] ??= [0, 0, 0, 0]);
      z[0]++;
      z[1] += l.bytes;
      if (shown.has(l.key)) {
        z[2]++;
        z[3] += l.bytes;
      }
    }
    const shownLoads = mine.filter((l) => shown.has(l.key));
    rows.push({
      scene,
      id: SCRIPT[i]!.id,
      settleMs,
      tiles: mine.length,
      bytes: mine.reduce((a, l) => a + l.bytes, 0),
      shownTiles: shownLoads.length,
      shownBytes: shownLoads.reduce((a, l) => a + l.bytes, 0),
      byZoom,
      elevationBytes: elevationBytes - elevBefore,
      refetchBytes: refetchBytes[scene] ?? 0,
      visibleByZoom,
    });
    elevBefore = elevationBytes;
    const r = rows[rows.length - 1]!;
    console.log(
      `[${LABEL}/${name}] 場面${scene} ${r.id}: 航空写真 ${r.tiles}枚 ${(r.bytes / 1e6).toFixed(2)}MB（表示 ${r.shownTiles}枚 ${(r.shownBytes / 1e6).toFixed(2)}MB）標高 ${(r.elevationBytes / 1e6).toFixed(2)}MB ${(settleMs / 1000).toFixed(0)}s`,
    );
    if (SHOT_SCENES.has(scene)) await page.screenshot({ path: `screenshots/ground-load/${LABEL}-${name}-${scene}.png` });
  }
  console.log(`[${LABEL}/${name}] 同じタイルを取り直した回数 ${refetched}`);
  writeFileSync(`screenshots/ground-load/${LABEL}-${name}.json`, JSON.stringify({ query: QUERY, refetched, rows }, null, 2));
  expect(errors).toEqual([]);
  await context.close();
  return rows;
}

for (const name of Object.keys(VIEWPORTS) as ViewportName[]) {
  test(`航空写真の読み込み量（${name === 'pc' ? 'PC 幅 1280×800' : 'スマートフォン幅 390×844'}）を場面ごとに測り、場面1の転送量が上限以下`, async ({ browser, baseURL }) => {
    mkdirSync('screenshots/ground-load', { recursive: true });
    const rows = await measure(browser, baseURL!, name);
    if (!QUERY && LABEL !== 'before') expect(rows[0]!.bytes).toBeLessThanOrEqual(SCENE1_ORTHO_LIMIT[name]);
  });
}
