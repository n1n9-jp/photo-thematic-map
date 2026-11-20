import { expect, test } from '@playwright/test';

const CASES = [
  { name: 'akihabara', query: 'name=akihabara', shot: 'grid-akihabara' },
  { name: 'marunouchi', query: 'name=marunouchi', shot: 'grid-marunouchi' },
  { name: 'gaien', query: 'name=gaien', shot: 'grid-gaien' },
  { name: 'akihabara', query: 'name=akihabara&view=top', shot: 'grid-akihabara-top' },
  { name: 'marunouchi', query: 'name=marunouchi&view=top', shot: 'grid-marunouchi-top' },
  { name: 'gaien', query: 'name=gaien&view=top', shot: 'grid-gaien-top' },
  { name: 'marunouchi', query: 'name=marunouchi&pile=1', shot: 'grid-marunouchi-pile' },
  { name: 'gaien', query: 'name=gaien&pile=1', shot: 'grid-gaien-pile' },
] as const;

for (const c of CASES) {
  test(`街の高さ格子の確認ページ: ${c.query}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

    await page.goto(`/demos/grid.html?${c.query}`);
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 90_000 });
    await expect(page.locator('canvas')).toHaveCount(1);

    const grid = await page.evaluate(() => window.__GRID__);
    expect(grid?.name).toBe(c.name);
    expect(grid?.missing).toBe(0);
    if (c.query.includes('pile=1')) {
      expect(grid?.pile).toBeDefined();
      expect(Math.abs(grid!.pile!.totalVolume / grid!.pile!.volume - 1)).toBeLessThan(0.005);
    }

    await page.waitForTimeout(500);
    await page.screenshot({ path: `screenshots/${c.shot}.png` });
    expect(errors).toEqual([]);
  });
}
