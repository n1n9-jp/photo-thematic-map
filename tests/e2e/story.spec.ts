import { expect, test, type Page } from '@playwright/test';

interface StoryState {
  stage: number;
  progress: number;
  position: number;
}

/** 各段階のカメラの高さ(m)。demos の定義（注視点の高さ + 距離 × sin(仰角)）に対応。 */
const EXPECTED_HEIGHT = [5 + 34 * Math.sin((14 * Math.PI) / 180), 100, 1000, 10_000];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

async function openStory(page: Page): Promise<void> {
  await page.goto('/demos/story.html');
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 30_000 });
}

const getState = (page: Page): Promise<StoryState> => page.evaluate(() => window.__STORY__!.getState());
const getCameraY = (page: Page): Promise<number> => page.evaluate(() => window.__STORY__!.getCameraPosition().y);

/** マウスホイールで、指定の段階に入って進捗が minProgress を超えるまでスクロールする。 */
async function wheelToStage(page: Page, index: number, minProgress = 0.27): Promise<void> {
  await page.mouse.move(20, 20);
  for (let n = 0; n < 400; n++) {
    const s = await getState(page);
    if (s.stage === index && s.progress >= minProgress) {
      // スムーズスクロールの残りが止まるのを待ってから、カメラが止まっている区間(進捗 0.4 未満)にいることを確かめる。
      await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { intervals: [150, 150, 150] }).toBe(
        await page.evaluate(() => Math.round(scrollY)),
      );
      const settled = await getState(page);
      expect(settled.stage).toBe(index);
      expect(settled.progress).toBeLessThan(0.4);
      return;
    }
    expect(s.stage, '行き過ぎ').toBeLessThanOrEqual(index);
    await page.mouse.wheel(0, 30);
    await page.waitForTimeout(80);
  }
  throw new Error(`段階 ${index} に到達できませんでした`);
}

async function expectCameraHeight(page: Page, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.abs((await getCameraY(page)) - expected) / expected, { timeout: 20_000 })
    .toBeLessThan(0.02);
}

test('スクロールで段階が進み、カメラが引いていく', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.story-step')).toHaveCount(4);

  const heights: number[] = [];
  const stages: number[] = [];
  for (let i = 0; i < 4; i++) {
    await wheelToStage(page, i);
    await expectCameraHeight(page, EXPECTED_HEIGHT[i] as number);
    stages.push((await getState(page)).stage);
    heights.push(await getCameraY(page));
    // 数値が最終値まで数え上がっている
    const stat = page.locator('.story-step').nth(i).locator('.story-stat__value');
    await expect(stat).toHaveText(['1', '1,200', '438,000', '7,300,000'][i] as string);
    // OrbitControls は最後の段階だけ有効
    await expect.poll(() => page.evaluate(() => window.__STORY__!.isFree())).toBe(i === 3);
    await page.screenshot({ path: `screenshots/story-${i + 1}.png` });
  }

  expect(stages).toEqual([0, 1, 2, 3]);
  for (let i = 1; i < heights.length; i++) {
    expect(heights[i] as number).toBeGreaterThan((heights[i - 1] as number) * 3);
  }
  expect(errors).toEqual([]);
});

test('上へ戻ると前の段階に戻り、自由操作が解除される', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await wheelToStage(page, 3);
  await expect.poll(() => page.evaluate(() => window.__STORY__!.isFree())).toBe(true);
  await page.mouse.wheel(0, -3000);
  await expect.poll(async () => (await getState(page)).stage, { timeout: 10_000 }).toBeLessThan(3);
  await expect.poll(() => page.evaluate(() => window.__STORY__!.isFree())).toBe(false);
  expect(errors).toEqual([]);
});

test('prefers-reduced-motion では数値とカメラが即時に切り替わる', async ({ page }) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStory(page);
  await page.mouse.move(20, 20);
  for (let n = 0; n < 200 && (await getState(page)).stage < 2; n++) {
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(40);
  }
  const state = await getState(page);
  expect(state.stage).toBe(2);
  // 進捗が小さいうちから最終値。カメラも補間を待たずにキーフレームの高さ。
  expect(state.progress).toBeLessThan(0.2);
  await expect(page.locator('.story-step').nth(2).locator('.story-stat__value')).toHaveText('438,000');
  await expectCameraHeight(page, EXPECTED_HEIGHT[2] as number);
  expect(errors).toEqual([]);
});

test.describe('幅 390px のスマートフォン', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('本文カードが画面幅に収まり、読める', async ({ page }) => {
    const errors = collectErrors(page);
    await openStory(page);
    await wheelToStage(page, 2);
    await expectCameraHeight(page, EXPECTED_HEIGHT[2] as number);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await page.locator('.story-step').nth(2).locator('.story-card').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    await page.screenshot({ path: 'screenshots/story-mobile.png' });
    expect(errors).toEqual([]);
  });
});
