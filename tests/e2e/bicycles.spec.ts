import { expect, test, type Page } from '@playwright/test';

/** ページを開き、準備完了とコンソールエラー0件を確認する。 */
async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  await page.goto(`/demos/bicycles.html?${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 45_000 });
  await expect(page.locator('canvas')).toHaveCount(1);
  // 描画が安定するまで数フレーム待つ
  await page.waitForTimeout(800);
  return errors;
}

const COUNT = 3000;
const SHOTS = [
  { query: 'view=closeup', file: 'bicycle-closeup.png', lod: 0 },
  { query: 'view=parked', file: 'bicycle-parked.png', lod: 0 },
  { query: 'view=heap', file: 'bicycle-heap.png', lod: 2 },
  // 原点から西へ 60km に置いても、近景が崩れずに描ける
  { query: 'view=closeup&far=1', file: 'bicycle-far-closeup.png', lod: 0 },
  // 駐輪の列と山積みの先頭の半分だけを表示する
  { query: 'view=overview&reveal=0.5', file: 'bicycle-reveal-half.png', lod: 2, reveal: 0.5 },
] as const;

// ソフトウェア描画では山積みの1フレームに時間がかかるため、余裕を持たせる
test.describe.configure({ mode: 'parallel', timeout: 120_000 });

for (const shot of SHOTS) {
  test(`自転車: ${shot.query} を描画する`, async ({ page }) => {
    const errors = await open(page, `${shot.query}&count=${COUNT}`);
    const stats = await page.evaluate(() => window.__BICYCLE_STATS__);
    expect(stats?.total).toBe(COUNT);
    expect(stats?.visible).toBeGreaterThan(0);
    expect(stats?.perLod[shot.lod]).toBeGreaterThan(0);
    if ('reveal' in shot) {
      // 見本の1台 + 列と山の半分
      expect(stats!.revealed).toBeGreaterThan(COUNT * shot.reveal - 2);
      expect(stats!.revealed).toBeLessThan(COUNT * shot.reveal + 2);
      expect(stats!.visible).toBeLessThanOrEqual(stats!.revealed);
    } else {
      expect(stats?.revealed).toBe(COUNT);
    }
    await expect(page.locator('#hud')).toContainText('3,000');
    await page.screenshot({ path: `screenshots/${shot.file}` });
    expect(errors).toEqual([]);
  });
}
