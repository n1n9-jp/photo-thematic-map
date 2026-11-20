import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// PLATEAU のタイルをネットワークから読むので、ソフトウェア描画でも間に合うよう長めに待つ
test.setTimeout(180_000);

const VIEWS = [
  { name: 'tokyo', query: '' },
  { name: 'shibuya', query: '?lat=35.65803&lon=139.70165' },
] as const;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

for (const view of VIEWS) {
  test(`PLATEAU の街並みが表示される（${view.name}）`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/demos/plateau.html${view.query}`);
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 150_000 });

    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(page.locator('.ptm-attribution')).toContainText('出典：国土交通省 Project PLATEAU');

    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/plateau-${view.name}.png` });

    expect(errors).toEqual([]);
  });
}
