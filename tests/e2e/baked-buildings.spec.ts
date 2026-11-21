/**
 * 変換済みの建物（public/data/buildings/。npm run data:buildings）。
 *
 * - 本編の既定は変換済みのデータで、PLATEAU の配信サーバーへ建物のタイルを要求しない。場面1 で建物が表示される。
 * - 変換済みのデータを読めないとき（404）は、建物なしで続け、警告は 1 件だけ、エラーは 0 件。
 * - 比較（PTM_COMPARE=1 のときだけ。PLATEAU から直接読むので時間とネットワークを使う）:
 *   場面1・2・5・6 を、変換済みのデータと直接読む経路（?buildings=live）で撮り、左右に並べた画像を
 *   screenshots/baked-compare-<場面>.png に保存する。
 *     PTM_COMPARE=1 npx playwright test tests/e2e/baked-buildings.spec.ts --trace off
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.setTimeout(1_500_000);
const SETTLE_TIMEOUT_MS = 420_000;
const PLATEAU_TILES = /assets\.cms\.plateau\.reearth\.io/;

function collect(page: Page): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return { errors, warnings };
}

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });
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

test('本編は変換済みの建物を読み、PLATEAU の配信サーバーへ建物のタイルを要求しない', async ({ page }) => {
  const { errors } = collect(page);
  const plateauRequests: string[] = [];
  const chunkRequests: string[] = [];
  page.on('request', (req) => {
    if (PLATEAU_TILES.test(req.url())) plateauRequests.push(req.url());
    if (req.url().includes('/data/buildings/')) chunkRequests.push(req.url());
  });
  await open(page);
  await goToScene(page, 0);
  const st = await page.evaluate(() => window.__MAIN__!.status().city);
  expect(st.buildingSource).toBe('baked');
  expect(st.baked?.manifest).toBe('ready');
  expect(st.baked?.detailChunks).toBeGreaterThan(0);
  expect(st.baked?.farChunks).toBeGreaterThan(0);
  expect(st.baked?.triangles).toBeGreaterThan(100_000);
  expect(st.baked?.failed).toBe(0);
  expect(chunkRequests.some((u) => u.endsWith('/data/buildings/manifest.json'))).toBe(true);
  expect(plateauRequests).toEqual([]);
  await page.screenshot({ path: 'screenshots/baked-buildings-1.png' });
  expect(errors).toEqual([]);
});

test('変換済みの建物を読めないときは、建物なしで続け、警告を 1 件だけ出す', async ({ page }) => {
  const { errors, warnings } = collect(page);
  let requests = 0;
  await page.route('**/data/buildings/**', (route) => {
    requests++;
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await open(page);
  await goToScene(page, 0);
  const st = await page.evaluate(() => window.__MAIN__!.status().city);
  expect(st.buildingSource).toBe('baked');
  expect(st.baked?.manifest).toBe('unavailable');
  expect(st.baked?.triangles).toBe(0);
  const mine = warnings.filter((w) => w.includes('変換済みの建物'));
  expect(mine).toHaveLength(1);
  // メタ情報だけを要求し、チャンクは要求しない
  expect(requests).toBe(1);
  // コンソールエラーは、ブラウザが失敗した要求ごとに出すもの（Failed to load resource）以外は出さない
  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
  expect(errors.length).toBeLessThanOrEqual(requests);
});

test.describe('直接読む経路との比較', () => {
  test.skip(!process.env.PTM_COMPARE, '比較用（PTM_COMPARE=1 のときだけ実行）');

  for (const scene of [0, 1, 4, 5]) {
    test(`場面${scene + 1}: 変換済み（左）と直接読む経路（右）`, async ({ browser }) => {
      const shots: Record<string, Buffer> = {};
      for (const mode of ['baked', 'live'] as const) {
        const page = await browser.newPage();
        const { errors } = collect(page);
        await open(page, mode === 'live' ? '?buildings=live' : '');
        await goToScene(page, scene);
        if (scene <= 1) await page.waitForTimeout(2500);
        const path = `screenshots/baked-compare-${scene + 1}-${mode}.png`;
        await page.screenshot({ path });
        shots[mode] = readFileSync(path);
        expect(errors).toEqual([]);
        await page.close();
      }
      // 左右に並べた 1 枚
      const page = await browser.newPage({ viewport: { width: 2560 + 16, height: 760 } });
      const img = (b: Buffer | undefined): string => `data:image/png;base64,${(b ?? Buffer.alloc(0)).toString('base64')}`;
      await page.setContent(
        `<body style="margin:0;background:#222;color:#fff;font:16px sans-serif;display:flex;gap:16px">` +
          `<figure style="margin:0"><figcaption style="height:40px;line-height:40px">変換済み（既定）</figcaption><img src="${img(shots.baked)}" width="1280" height="720"></figure>` +
          `<figure style="margin:0"><figcaption style="height:40px;line-height:40px">直接読む経路（?buildings=live）</figcaption><img src="${img(shots.live)}" width="1280" height="720"></figure>` +
          `</body>`,
      );
      await page.screenshot({ path: `screenshots/baked-compare-${scene + 1}.png` });
      await page.close();
    });
  }
});
