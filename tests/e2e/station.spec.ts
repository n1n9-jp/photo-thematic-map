import { expect, test, type Page } from '@playwright/test';

/** 確認ページを開き、準備完了とコンソールエラー0件を確認する。 */
async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  await page.goto(`/demos/station.html?${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 45_000 });
  await expect(page.locator('canvas')).toHaveCount(1);
  await page.waitForTimeout(800);
  return errors;
}

const SHOTS = [
  { query: 'count=462&view=overview', file: 'station-overview.png', count: 462 },
  { query: 'count=462&view=street', file: 'station-street.png', count: 462 },
  { query: 'count=40&view=overview', file: 'station-40.png', count: 40 },
] as const;

test.describe.configure({ timeout: 120_000 });

for (const shot of SHOTS) {
  test(`駅の配置: ${shot.file}`, async ({ page }) => {
    const errors = await open(page, shot.query);
    const result = await page.evaluate(() => window.__STATION__);
    expect(result?.placed).toBe(shot.count);
    expect(result?.maxDistance).toBeLessThanOrEqual(500);
    await page.screenshot({ path: `screenshots/${shot.file}` });
    expect(errors).toEqual([]);
  });
}

test('駅の配置: shown で先頭の台数だけを表示する', async ({ page }) => {
  const errors = await open(page, 'count=462&shown=100');
  const result = await page.evaluate(() => window.__STATION__);
  expect(result?.placed).toBe(462);
  expect(result?.shown).toBe(100);
  await expect(page.locator('#hud')).toContainText('表示 100');
  expect(errors).toEqual([]);
});
