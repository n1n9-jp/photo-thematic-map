import { expect, test, type Page } from '@playwright/test';

/** 確認ページを開き、準備完了とコンソールエラー0件を確認できるようにする。 */
async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  await page.goto(`/demos/stations-overview.html?${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 45_000 });
  await expect(page.locator('canvas')).toHaveCount(1);
  await page.waitForTimeout(600);
  return errors;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ラベルが画面内に収まり、互いに・凡例と重ならないことを確認する。ラベルの数を返す。 */
async function expectLabelsReadable(page: Page): Promise<number> {
  const vp = page.viewportSize()!;
  const boxes: Box[] = [];
  for (const el of await page.locator('.sm-label:visible').all()) boxes.push((await el.boundingBox())!);
  const legend = (await page.locator('.sm-legend').boundingBox())!;
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  }
  const hit = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  for (let i = 0; i < boxes.length; i++) {
    expect(hit(boxes[i]!, legend)).toBe(false);
    for (let j = i + 1; j < boxes.length; j++) expect(hit(boxes[i]!, boxes[j]!)).toBe(false);
  }
  return boxes.length;
}

const SHOTS = [
  { view: 'wards', shape: 'column', file: 'stations-wards-column.png' },
  { view: 'wards', shape: 'cone', file: 'stations-wards-cone.png' },
  { view: 'tokyo', shape: 'column', file: 'stations-tokyo-column.png' },
] as const;

test.describe.configure({ timeout: 120_000 });
test.use({ deviceScaleFactor: 2 });

for (const shot of SHOTS) {
  test(`駅ごとの印: ${shot.view} × ${shot.shape}`, async ({ page }) => {
    const errors = await open(page, `view=${shot.view}&shape=${shot.shape}`);
    const result = await page.evaluate(() => window.__STATIONS_OVERVIEW__!);
    expect(result.sites).toBe(489);
    expect(result.total).toBe(13_394);
    expect(await expectLabelsReadable(page)).toBeGreaterThanOrEqual(8);
    await expect(page.locator('.sm-legend')).toContainText('合計 13,394台');
    await expect(page.locator('.sm-legend')).toContainText('2025年10月、晴天の平日の午前11時頃に数えた台数');
    await expect(page.locator('.sm-legend-scale')).toContainText(shot.shape === 'column' ? '柱の高さ 1km ＝ 100台' : '山の体積 1km³ ＝ 500台');
    if (shot.view === 'wards') {
      expect(result.cameraHeight).toBeGreaterThan(20_000);
      expect(result.cameraHeight).toBeLessThan(40_000);
      await expect(page.locator('.sm-label', { hasText: '秋葉原' })).toBeVisible();
    }
    await page.screenshot({ path: `screenshots/${shot.file}` });
    expect(errors).toEqual([]);
  });
}

test.describe('スマートフォンの幅（390×844）', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('wards × column', async ({ page }) => {
    const errors = await open(page, 'view=wards&shape=column');
    expect(await expectLabelsReadable(page)).toBeGreaterThanOrEqual(5);
    // 凡例は画面の幅に収まる
    const legend = (await page.locator('.sm-legend').boundingBox())!;
    expect(legend.x).toBeGreaterThanOrEqual(0);
    expect(legend.x + legend.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'screenshots/stations-wards-column-mobile.png' });
    expect(errors).toEqual([]);
  });
});

test('全体の表示を 0〜1 で切り替えると、印・ラベル・凡例が一緒に薄くなり、0 で消える', async ({ page }) => {
  const errors = await open(page, 'view=wards&shape=column');
  const opacity = (): Promise<string> => page.evaluate(() => getComputedStyle(document.querySelector('.sm-overlay')!).opacity);
  expect(await opacity()).toBe('1');
  await page.evaluate(() => window.__STATIONS_OVERVIEW__!.setVisibility(0.4));
  expect(Number(await opacity())).toBeCloseTo(0.4, 5);
  await page.evaluate(() => window.__STATIONS_OVERVIEW__!.setVisibility(0));
  await expect(page.locator('.sm-legend')).toBeHidden();
  expect(errors).toEqual([]);
});
