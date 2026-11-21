import { expect, test, type Page } from '@playwright/test';

interface StoryState {
  stage: number;
  progress: number;
  position: number;
}

/** 各段階のカメラの高さ(m)。demos の定義（注視点の高さ + 距離 × sin(仰角)）に対応。 */
const EXPECTED_HEIGHT = [5 + 34 * Math.sin((14 * Math.PI) / 180), 100, 1000, 10_000];
const STAGE_IDS = ['closeup', 'above-100m', 'above-1km', 'above-10km'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

async function openStory(page: Page, query = ''): Promise<void> {
  await page.goto(`/demos/story.html${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 30_000 });
}

const getState = (page: Page): Promise<StoryState> => page.evaluate(() => window.__STORY__!.getState());
const getCameraY = (page: Page): Promise<number> => page.evaluate(() => window.__STORY__!.getCameraPosition().y);
const isFree = (page: Page): Promise<boolean> => page.evaluate(() => window.__STORY__!.isFree());
const getScrollY = (page: Page): Promise<number> => page.evaluate(() => Math.round(window.scrollY));

/**
 * 段階 index の進捗 progress になる位置へ直接スクロールする。
 * 位置はページの DOM から求める（段階の進捗の定義: 上端が画面中央で 0、下端が画面中央で 1。最初は 0 から、最後はページ末尾まで）。
 */
async function scrollToStage(page: Page, index: number, progress = 0.1): Promise<void> {
  await page.evaluate(
    ([i, p]) => {
      const sections = [...document.querySelectorAll<HTMLElement>('.story-step')];
      const half = window.innerHeight / 2;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const top = (el: HTMLElement): number => el.getBoundingClientRect().top + window.scrollY;
      const s = sections[i]!;
      const start = i === 0 ? 0 : top(s) - half;
      const end = i === sections.length - 1 ? max : top(s) + s.offsetHeight - half;
      window.scrollTo({ top: Math.round(start + (end - start) * p), left: 0, behavior: 'instant' });
    },
    [index, progress] as const,
  );
  await expect.poll(async () => (await getState(page)).stage).toBe(index);
}

async function expectCameraHeight(page: Page, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.abs((await getCameraY(page)) - expected) / expected, { timeout: 20_000 })
    .toBeLessThan(0.02);
}

/** CDP でタッチのスワイプを送る（1本指）。 */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  const steps = 12;
  for (let n = 1; n <= steps; n++) {
    const x = from.x + ((to.x - from.x) * n) / steps;
    const y = from.y + ((to.y - from.y) * n) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(300);
}

test('スクロールで段階が進み、カメラが引いていく', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.story-step')).toHaveCount(4);

  const heights: number[] = [];
  const stages: number[] = [];
  const toggle = page.locator('.story-free-toggle');
  for (let i = 0; i < 4; i++) {
    await scrollToStage(page, i, 0.1);
    await expectCameraHeight(page, EXPECTED_HEIGHT[i] as number);
    stages.push((await getState(page)).stage);
    heights.push(await getCameraY(page));
    // 数値が最終値まで数え上がっている
    const stat = page.locator('.story-step').nth(i).locator('.story-stat__value');
    await expect(stat).toHaveText(['1', '1,200', '438,000', '7,300,000'][i] as string);
    // 自由操作のボタンは freeOrbit の段階（最後）だけに出る。押すまでは自由操作にならない。
    if (i === 3) await expect(toggle).toBeVisible();
    else await expect(toggle).toBeHidden();
    expect(await isFree(page)).toBe(false);
    await page.screenshot({ path: `screenshots/story-${i + 1}.png` });
  }

  expect(stages).toEqual([0, 1, 2, 3]);
  for (let i = 1; i < heights.length; i++) {
    expect(heights[i] as number).toBeGreaterThan((heights[i - 1] as number) * 3);
  }

  // 場面のセクションは見出しで名前がつく
  const section = page.locator('.story-step').nth(1);
  const labelledBy = await section.getAttribute('aria-labelledby');
  expect(labelledBy).toBeTruthy();
  await expect(page.locator(`[id="${labelledBy}"]`)).toHaveText('100m上空から');
  await expect(page.getByRole('region', { name: '100m上空から' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('カメラが止まっていて入力もなければ描画しない', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await scrollToStage(page, 1, 0.1);
  await expectCameraHeight(page, EXPECTED_HEIGHT[1] as number);
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => window.__STORY__!.renderCount());
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__STORY__!.renderCount())).toBe(before);
  // 動けばまた描画する
  await scrollToStage(page, 2, 0.1);
  await expect.poll(() => page.evaluate(() => window.__STORY__!.renderCount())).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('自由操作はボタンで入って出る（キーボード・マウス）。段階を離れると解除される', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await scrollToStage(page, 3, 0.1);
  await expectCameraHeight(page, EXPECTED_HEIGHT[3] as number);
  const toggle = page.locator('.story-free-toggle');
  await expect(toggle).toHaveText('地図を動かす');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // キーボードで入る
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => isFree(page)).toBe(true);
  await expect(toggle).toHaveText('読み進める');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeInViewport();

  // マウスのドラッグでカメラが回る
  const before = await page.evaluate(() => window.__STORY__!.getCameraPosition());
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(600, 320, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__STORY__!.getCameraPosition());
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(10);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'screenshots/story-free-desktop.png' });

  // キーボードで出る
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => isFree(page)).toBe(false);
  await expect(toggle).toHaveText('地図を動かす');

  // マウスで入り、Esc で出る
  await toggle.click();
  await expect.poll(() => isFree(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => isFree(page)).toBe(false);

  // 自由操作のまま上へ戻ると、解除されてボタンも消える
  await toggle.click();
  await expect.poll(() => isFree(page)).toBe(true);
  await scrollToStage(page, 1, 0.1);
  await expect.poll(() => isFree(page)).toBe(false);
  await expect(toggle).toBeHidden();
  await expectCameraHeight(page, EXPECTED_HEIGHT[1] as number);
  expect(errors).toEqual([]);
});

test('prefers-reduced-motion では数値とカメラが即時に切り替わる', async ({ page }) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStory(page);
  await scrollToStage(page, 2, 0.05);
  const state = await getState(page);
  expect(state.stage).toBe(2);
  await expect(page.locator('.story-step').nth(2).locator('.story-stat__value')).toHaveText('438,000', { timeout: 500 });
  await expectCameraHeight(page, EXPECTED_HEIGHT[2] as number);
  expect(errors).toEqual([]);
});

test('途中で再読み込みすると、各段階の onProgress が現在の位置に合わせて呼ばれる', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await scrollToStage(page, 2, 0.2);
  const y = await getScrollY(page);
  await page.reload();
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 30_000 });
  // スクロール位置が復元されている
  await expect.poll(() => getScrollY(page)).toBeGreaterThan(y - 5);
  await expect.poll(async () => (await getState(page)).stage).toBe(2);
  const { progress } = await getState(page);
  await expect
    .poll(() => page.evaluate(() => window.__STORY_PROGRESS__ ?? {}))
    .toEqual({ [STAGE_IDS[0]!]: 1, [STAGE_IDS[1]!]: 1, [STAGE_IDS[2]!]: progress, [STAGE_IDS[3]!]: 0 });
  expect(errors).toEqual([]);
});

test('一度に段階を飛び越えても、間の段階へ 1 / 0 が届く', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await scrollToStage(page, 3, 0.1);
  await expect.poll(() => page.evaluate(() => ({ ...window.__STORY_PROGRESS__ }))).toMatchObject({
    [STAGE_IDS[0]!]: 1,
    [STAGE_IDS[1]!]: 1,
    [STAGE_IDS[2]!]: 1,
  });
  await scrollToStage(page, 0, 0.1);
  await expect.poll(() => page.evaluate(() => ({ ...window.__STORY_PROGRESS__ }))).toMatchObject({
    [STAGE_IDS[1]!]: 0,
    [STAGE_IDS[2]!]: 0,
    [STAGE_IDS[3]!]: 0,
  });
  expect(errors).toEqual([]);
});

test('リサイズと画面の回転で、読んでいる段階と進捗が変わらない', async ({ page }) => {
  const errors = collectErrors(page);
  await openStory(page);
  await scrollToStage(page, 2, 0.3);
  const before = await getState(page);
  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(800);
    const s = await getState(page);
    expect(s.stage, `${size.width}x${size.height}`).toBe(before.stage);
    expect(Math.abs(s.progress - before.progress), `${size.width}x${size.height}`).toBeLessThan(0.03);
    // 描画バッファは新しい画面の大きさに合う
    const canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas')!;
      return { w: c.clientWidth, h: c.clientHeight };
    });
    expect(canvas).toEqual({ w: size.width, h: size.height });
  }
  expect(errors).toEqual([]);
});

test.describe('幅 390px のスマートフォン', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('本文カードが画面幅に収まり、読める', async ({ page }) => {
    const errors = collectErrors(page);
    await openStory(page);
    await scrollToStage(page, 2, 0.1);
    await expectCameraHeight(page, EXPECTED_HEIGHT[2] as number);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const box of await cardBoxes(page, 2)) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }

    await page.screenshot({ path: 'screenshots/story-mobile.png' });
    expect(errors).toEqual([]);
  });

  test('自由操作に入れる段階でも、1本指の縦スワイプでスクロールでき、ボタンで入って出られる', async ({ page }) => {
    const errors = collectErrors(page);
    await openStory(page);
    await scrollToStage(page, 3, 0.3);
    await expectCameraHeight(page, EXPECTED_HEIGHT[3] as number);
    // カメラが止まりきってから（修正前は、ここで自由操作に切り替わり canvas がスワイプを奪っていた）
    await page.waitForTimeout(1500);
    // カードの外（canvas の上）を下へスワイプ → 上へスクロールする
    const y0 = await getScrollY(page);
    // カードは画面の下寄りにしかない。上側は canvas。
    const above = 40;
    await swipe(page, { x: 30, y: above }, { x: 30, y: above + 250 });
    expect(await getScrollY(page)).toBeLessThan(y0 - 50);

    // ボタンで入る
    await scrollToStage(page, 3, 0.3);
    const toggle = page.locator('.story-free-toggle');
    await expect(toggle).toBeVisible();
    await toggle.tap();
    await expect.poll(() => isFree(page)).toBe(true);
    await expect(toggle).toHaveText('読み進める');
    await expect(toggle).toBeInViewport();
    await page.waitForTimeout(400); // カードが薄くなるのを待つ
    await page.screenshot({ path: 'screenshots/story-free.png' });

    // 1本指の横スワイプで回る
    const before = await page.evaluate(() => window.__STORY__!.getCameraPosition());
    await swipe(page, { x: 80, y: 300 }, { x: 330, y: 300 });
    const after = await page.evaluate(() => window.__STORY__!.getCameraPosition());
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(10);

    // ボタンで出る
    await toggle.tap();
    await expect.poll(() => isFree(page)).toBe(false);
    await expect(toggle).toHaveText('地図を動かす');

    // 自由操作の間も、縦スワイプはスクロールになる
    await toggle.tap();
    await expect.poll(() => isFree(page)).toBe(true);
    const y1 = await getScrollY(page);
    await swipe(page, { x: 30, y: 200 }, { x: 30, y: 450 });
    expect(await getScrollY(page)).toBeLessThan(y1 - 50);
    expect(errors).toEqual([]);
  });
});

test.describe('幅 320px・長い本文', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('数値は画面に入ってから数え上がり、カメラは最後のカードが止まり終えるまで止まる', async ({ page }) => {
    const errors = collectErrors(page);
    await openStory(page, '?long=1');
    const stat = page.locator('.story-step').nth(1).locator('.story-stat__value');
    // 長い本文は、段落ごとに別のカードになる（最初のカード + 5段落）
    await expect(page.locator('.story-step').nth(1).locator('.story-card')).toHaveCount(6);

    const hold = (await page.evaluate(() => window.__STORY__!.getHolds()))[1] as number;
    expect(hold).toBeGreaterThan(0.5);

    // 段階に入った直後: 数値のあるカードは画面の下端から入ってきたところ。
    await scrollToStage(page, 1, 0.02);
    await expectCameraHeight(page, EXPECTED_HEIGHT[1] as number);
    await expect(stat).toHaveText('1,200');
    await page.screenshot({ path: 'screenshots/story-long-320.png' });

    // 本文を読んでいる途中（最後のカードが止まり終えるより前）: カメラは止まったまま
    await scrollToStage(page, 1, hold - 0.05);
    await page.waitForTimeout(1000);
    await expectCameraHeight(page, EXPECTED_HEIGHT[1] as number);
    expect((await getState(page)).stage).toBe(1);

    // 最後のカードが止まり終えたあと、次の場面へ動き出す
    await scrollToStage(page, 1, Math.min(hold + 0.15, 0.98));
    await expect.poll(() => getCameraY(page), { timeout: 10_000 }).toBeGreaterThan((EXPECTED_HEIGHT[1] as number) * 1.2);
    expect(errors).toEqual([]);
  });
});

/** 場面 index のカードの、画面上の長方形のうち見えているもの（薄くなって消えたカードを除く）。 */
async function cardBoxes(page: Page, index: number): Promise<{ x: number; y: number; width: number; height: number }[]> {
  return page.evaluate((i) => {
    const out: { x: number; y: number; width: number; height: number }[] = [];
    for (const c of document.querySelectorAll<HTMLElement>(`.story-step:nth-child(${i + 1}) .story-card`)) {
      const r = c.getBoundingClientRect();
      if (Number(getComputedStyle(c).opacity) > 0.05 && r.bottom > 0 && r.top < window.innerHeight) {
        out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    return out;
  }, index);
}

/** 画面に見えているカードすべての長方形。 */
async function visibleCards(page: Page): Promise<{ x: number; y: number; width: number; height: number }[]> {
  return page.evaluate(() => {
    const out: { x: number; y: number; width: number; height: number }[] = [];
    for (const c of document.querySelectorAll<HTMLElement>('.story-card')) {
      const r = c.getBoundingClientRect();
      if (Number(getComputedStyle(c).opacity) > 0.05 && r.bottom > 0 && r.top < window.innerHeight) {
        out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    return out;
  });
}

const SIZES = [
  { name: 'phone-390x844', width: 390, height: 844, layout: 'bottom' },
  { name: 'phone-320x568', width: 320, height: 568, layout: 'bottom' },
  { name: 'landscape-844x390', width: 844, height: 390, layout: 'side' },
  { name: 'desktop-1280x720', width: 1280, height: 720, layout: 'side' },
] as const;

for (const size of SIZES) {
  test.describe(`本文カードの配置 ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('カードは小さく分かれて流れ、画面の端と主役の範囲を避ける', async ({ page }) => {
      const errors = collectErrors(page);
      await openStory(page);
      const { width: W, height: H } = size;
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.story')!).getPropertyValue('--story-layout').trim())).toBe(size.layout);

      // 場面1は、最初のカード + 段落2つ。数値は最初のカードにある。
      const first = page.locator('.story-step').first();
      await expect(first.locator('.story-card')).toHaveCount(3);
      await expect(first.locator('.story-card').first().locator('.story-stat__value')).toHaveCount(1);
      await expect(first.locator('.story-card').nth(1).locator('.story-stat__value')).toHaveCount(0);

      // すべてのカード: 画面の幅に収まる。縦向きの幅では、高さが画面の4割以下。
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.story-card')].map((c) => ({ w: c.offsetWidth, h: c.offsetHeight })),
      );
      for (const c of sizes) {
        expect(c.w).toBeLessThanOrEqual(W);
        if (size.layout === 'bottom') expect(c.h).toBeLessThanOrEqual(H * 0.4);
        else expect(c.h).toBeLessThanOrEqual(H * 0.7);
      }
      if (size.layout === 'side') {
        const w = sizes[0]!.w;
        // PC 幅は 360〜400px。高さの低い横向きの画面だけ、少し狭くしてカードを低く保つ（340px〜）。
        expect(w).toBeGreaterThanOrEqual(H <= 560 ? 340 : 360);
        expect(w).toBeLessThanOrEqual(400);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

      // 場面を通してスクロールし、見えているカードの位置を調べる。
      const total = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      let visibleSamples = 0;
      let emptyRun = 0;
      let longestEmptyRun = 0;
      const step = Math.max(Math.round(H / 20), 8);
      const freeBottom = H / 2; // 縦向きでは、上半分にカードは出ない
      for (let y = 0; y <= total; y += step) {
        await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), y);
        await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
        const cards = await visibleCards(page);
        if (cards.length === 0) {
          emptyRun += step;
          longestEmptyRun = Math.max(longestEmptyRun, emptyRun);
        } else {
          emptyRun = 0;
          visibleSamples++;
        }
        for (const c of cards) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.x + c.width).toBeLessThanOrEqual(W);
          if (size.layout === 'bottom') expect(c.y, `y=${y}`).toBeGreaterThanOrEqual(freeBottom - 1);
        }
        // 2枚以上同時に見えるとき、重なっていない
        for (let i = 0; i < cards.length; i++) {
          for (let j = i + 1; j < cards.length; j++) {
            const a = cards[i]!;
            const b = cards[j]!;
            expect(a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1, `y=${y} overlap`).toBe(true);
          }
        }
      }
      expect(visibleSamples).toBeGreaterThan(10);
      // 縦向きでは、カードとカードのあいだに、3D が遮られずに見える間隔（画面の高さの半分以上）がある。
      // 横の配置では、主役はカードの列の外にあるので、間隔は要らない。
      if (size.layout === 'bottom') expect(longestEmptyRun).toBeGreaterThanOrEqual(H * 0.5);
      expect(errors).toEqual([]);
    });

    test('注視点が、カードに覆われていない範囲の中央に来る', async ({ page }) => {
      const errors = collectErrors(page);
      await openStory(page);
      const { width: W, height: H } = size;
      for (const stageIndex of [1, 3]) {
        await scrollToStage(page, stageIndex, 0.05);
        await expectCameraHeight(page, EXPECTED_HEIGHT[stageIndex] as number);
        await page.waitForTimeout(200);
        const target = await page.evaluate(() => window.__STORY__!.targetOnScreen());
        const info = await page.evaluate(() => {
          const cards = [...document.querySelectorAll<HTMLElement>('.story-card')];
          return {
            columnRight: Math.max(...cards.map((c) => c.getBoundingClientRect().right)),
            coverTop: Math.min(...cards.map((c) => Number.parseFloat(getComputedStyle(c).top))),
          };
        });
        if (size.layout === 'side') {
          expect(target.x).toBeGreaterThan(info.columnRight);
          expect(Math.abs(target.x - (info.columnRight + W) / 2)).toBeLessThan(W * 0.08);
          expect(Math.abs(target.y - H / 2)).toBeLessThan(H * 0.05);
        } else {
          expect(target.y).toBeLessThan(info.coverTop);
          expect(Math.abs(target.x - W / 2)).toBeLessThan(W * 0.03);
          expect(target.y).toBeGreaterThan(H * 0.1);
        }
      }
      // 自由操作の間も、注視点の位置は変わらない
      const before = await page.evaluate(() => window.__STORY__!.targetOnScreen());
      const toggle = page.locator('.story-free-toggle');
      await expect(toggle).toBeVisible();
      const tb = await toggle.boundingBox();
      expect(tb!.x).toBeGreaterThanOrEqual(0);
      expect(tb!.x + tb!.width).toBeLessThanOrEqual(W);
      expect(tb!.y).toBeGreaterThanOrEqual(0);
      expect(tb!.y + tb!.height).toBeLessThanOrEqual(H);
      await toggle.click();
      await expect.poll(() => isFree(page)).toBe(true);
      await page.waitForTimeout(400);
      const during = await page.evaluate(() => window.__STORY__!.targetOnScreen());
      expect(Math.hypot(during.x - before.x, during.y - before.y)).toBeLessThan(2);
      await page.screenshot({ path: `screenshots/story-layout-${size.name}-free.png` });
      await toggle.click();
      await expect.poll(() => isFree(page)).toBe(false);
      expect(errors).toEqual([]);
    });

    test('スクリーンショット', async ({ page }) => {
      const errors = collectErrors(page);
      await openStory(page);
      for (const [stageIndex, p] of [
        [0, 0],
        [1, 0.05],
        [3, 0.05],
      ] as const) {
        await scrollToStage(page, stageIndex, p);
        await expectCameraHeight(page, EXPECTED_HEIGHT[stageIndex] as number);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `screenshots/story-layout-${size.name}-${stageIndex + 1}.png` });
      }
      expect(errors).toEqual([]);
    });
  });
}
