/**
 * 確認ページ demos/akihabara.html: 秋葉原駅の周りの 462台の配置（真上からの全体図と、路上の目線）。
 */
import { expect, test, type Page } from '@playwright/test';

// ソフトウェア描画（SwiftShader）では、地上の目線の地面と建物の読み込みに数分かかる
test.describe.configure({ timeout: 600_000 });

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  await page.goto(`/demos/akihabara.html?${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 480_000 });
  await expect(page.locator('canvas')).toHaveCount(1);
  // 街並みの残りのタイルを待つ
  await page.waitForTimeout(3000);
  return errors;
}

/** 真上からの全体図（駅から 500m の円と足元の印つき）と、路上の目線（場面1 のカメラ）。 */
const SHOTS = [
  { query: 'view=top', file: 'akihabara-top.png' },
  { query: 'view=street', file: 'akihabara-street.png' },
] as const;

for (const shot of SHOTS) {
  test(`秋葉原の配置: ${shot.file}`, async ({ page }) => {
    const errors = await open(page, shot.query);
    const r = await page.evaluate(() => window.__AKIHABARA_DEMO__!);
    expect(r.placed).toBe(462);
    expect(r.shown).toBe(462);
    expect(r.onGround + r.underBridge).toBe(462);
    expect(r.maxDistanceM).toBeLessThanOrEqual(500);
    // 自転車の高さは街並みの地面（標高タイル）と合う
    expect(r.groundDiffMax).toBeLessThan(0.5);
    await page.screenshot({ path: `screenshots/${shot.file}` });
    expect(errors).toEqual([]);
  });
}
