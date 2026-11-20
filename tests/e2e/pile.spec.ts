import { expect, test } from '@playwright/test';

const CASES = [
  { name: 'small', volume: 8000 },
  { name: 'medium', volume: 80000 },
  { name: 'large', volume: 500000 },
] as const;

for (const c of CASES) {
  test(`堆積の確認ページ: ${c.name}（${c.volume} m³）`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

    await page.goto(`/demos/pile.html?volume=${c.volume}`);
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 30_000 });
    await expect(page.locator('canvas')).toHaveCount(1);

    const pile = await page.evaluate(() => window.__PILE__);
    expect(pile).toBeDefined();
    expect(Math.abs(pile!.totalVolume / c.volume - 1)).toBeLessThan(0.005);

    await page.waitForTimeout(500);
    await page.screenshot({ path: `screenshots/pile-${c.name}.png` });
    expect(errors).toEqual([]);
  });
}
