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

const SHOTS = [
  { view: 'closeup', file: 'bicycle-closeup.png', lod: 0 },
  { view: 'parked', file: 'bicycle-parked.png', lod: 0 },
  { view: 'heap', file: 'bicycle-heap.png', lod: 2 },
] as const;

// ソフトウェア描画では山積み（数百万三角形）の1フレームに数秒かかるため、余裕を持たせる
test.describe.configure({ timeout: 180_000 });

for (const shot of SHOTS) {
  test(`自転車: ${shot.view} を描画する`, async ({ page }) => {
    const errors = await open(page, `view=${shot.view}&count=30000`);
    const stats = await page.evaluate(() => window.__BICYCLE_STATS__);
    expect(stats?.total).toBe(30000);
    expect(stats?.visible).toBeGreaterThan(0);
    expect(stats?.perLod[shot.lod]).toBeGreaterThan(0);
    await expect(page.locator('#hud')).toContainText('30,000');
    await page.screenshot({ path: `screenshots/${shot.file}` });
    expect(errors).toEqual([]);
  });
}
