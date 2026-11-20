import { expect, test } from '@playwright/test';

// 本編は PLATEAU の街並みをネットワークから読むので、ソフトウェア描画でも間に合うよう長めに待つ
test.setTimeout(180_000);

test('本編が起動して最初の場面が描画される', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

  await page.goto('/');
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });

  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.story-card').first()).toContainText('秋葉原駅前の1台');
  await expect(page.locator('.ptm-site-attribution')).toContainText('出典：国土交通省 PLATEAU');

  await page.waitForTimeout(500);
  await page.screenshot({ path: 'screenshots/smoke.png' });

  expect(errors).toEqual([]);
});
