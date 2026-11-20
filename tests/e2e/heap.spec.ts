import { expect, test, type Page } from '@playwright/test';

/** E2E では所要時間を抑えるため 30,000 台にする。 */
const COUNT = 30000;

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  await page.goto(`/demos/heap.html?count=${COUNT}&${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 90_000 });
  await expect(page.locator('canvas')).toHaveCount(1);
  // 描画が安定するまで数フレーム待つ
  await page.waitForTimeout(1500);
  return errors;
}

const SHOTS = [
  { name: 'overview', query: 'view=overview', file: 'heap-overview.png' },
  { name: 'base', query: 'view=base', file: 'heap-base.png' },
  { name: 'reveal30', query: 'view=overview&reveal=0.3', file: 'heap-reveal30.png' },
] as const;

// ソフトウェア描画では数百万三角形の1フレームに数秒かかるため、余裕を持たせる
test.describe.configure({ timeout: 240_000 });

for (const shot of SHOTS) {
  test(`自転車の山: ${shot.name}`, async ({ page }) => {
    const errors = await open(page, shot.query);
    const heap = await page.evaluate(() => window.__HEAP__);
    expect(heap).toBeDefined();
    expect(heap!.represented).toBe(COUNT);
    expect(heap!.placed).toBe(COUNT);
    expect(heap!.maxBelowGround).toBeLessThan(0.01);
    expect(heap!.drawn).toBeGreaterThan(0);
    if (shot.name === 'reveal30') {
      expect(Math.abs(heap!.shown / COUNT - 0.3)).toBeLessThan(0.02);
    } else {
      expect(heap!.shown).toBe(COUNT);
    }
    await expect(page.locator('#info')).toContainText('30,000');
    await page.screenshot({ path: `screenshots/${shot.file}` });
    expect(errors).toEqual([]);
  });
}

test('自転車の山: 表層だけを置く', async ({ page }) => {
  const errors = await open(page, 'view=overview&surface=1');
  const heap = await page.evaluate(() => window.__HEAP__);
  expect(heap!.represented).toBe(COUNT);
  expect(heap!.placed).toBeGreaterThan(0);
  expect(heap!.placed).toBeLessThan(COUNT);
  await page.screenshot({ path: 'screenshots/heap-surface.png' });
  expect(errors).toEqual([]);
});
