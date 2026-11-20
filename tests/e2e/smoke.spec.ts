import { expect, test } from '@playwright/test';

test('起動してシーンが描画される', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

  await page.goto('/');
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 30_000 });

  await expect(page.locator('canvas')).toHaveCount(1);

  // 描画が安定するまで数フレーム待つ
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/smoke.png' });

  expect(errors).toEqual([]);
});
