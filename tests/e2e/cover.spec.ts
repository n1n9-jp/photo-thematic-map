import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// 本編は PLATEAU の街並みを読むので、ソフトウェア描画でも間に合うよう長めに待つ
test.setTimeout(180_000);

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

type Rect = { left: number; top: number; right: number; bottom: number };

const rectOf = (page: Page, selector: string): Promise<Rect | null> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);

const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** 不透明度が 0.05 を超え、画面に入っている本文カードの長方形。 */
const visibleCards = (page: Page): Promise<Rect[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.story-card')]
      .filter((c) => Number(getComputedStyle(c).opacity) > 0.05)
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.bottom > 0 && r.top < window.innerHeight)
      .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
  );

const nextFrames = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));

const SIZES = [
  { name: 'pc', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-small', width: 320, height: 568 },
  { name: 'landscape', width: 844, height: 390 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

for (const size of SIZES) {
  test.describe(`表紙 ${size.name}（${size.width}×${size.height}）`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('表紙が最初に出て、スクロールすると場面1のカードが出る', async ({ page }) => {
      const errors = collectErrors(page);
      // JavaScript を止めても、題名とリード文は出る（静的な HTML）。
      await page.route('**/*.js', (route) => route.abort());
      await page.goto('/');
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText('東京の放置自転車');
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.ptm-cover__lead')).toContainText('1万3,394台');
      await expect(page.locator('.ptm-cover__lead')).toContainText('18万7,262台');
      await page.unroute('**/*.js');
      errors.length = 0;

      await page.goto('/');
      await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 150_000 });
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('.ptm-cover__panel')).toBeVisible();
      // 場面1の始まり（進捗 0）は、表紙を通り過ぎた位置。表紙の間は場面1の進捗 0。
      const coverHeight = await page.evaluate(() => document.querySelector<HTMLElement>('.ptm-cover')!.offsetHeight);
      expect(coverHeight).toBeGreaterThanOrEqual(size.height - 1);
      expect(await page.evaluate(() => window.__MAIN__!.scrollYFor(0, 0))).toBeCloseTo(coverHeight, 0);
      expect(await page.evaluate(() => window.__MAIN__!.getState())).toMatchObject({ stage: 0, progress: 0 });

      // 表紙のパネルは画面に収まり、横にあふれず、出典表示・読み込みの表示・本文カードと重ならない。
      const panel = (await rectOf(page, '.ptm-cover__panel'))!;
      expect(panel.left).toBeGreaterThanOrEqual(0);
      expect(panel.right).toBeLessThanOrEqual(size.width);
      expect(panel.top).toBeGreaterThanOrEqual(0);
      expect(panel.bottom).toBeLessThanOrEqual(size.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      const attribution = (await rectOf(page, '.ptm-site-attribution'))!;
      expect(overlaps(panel, attribution), 'パネルと出典表示').toBe(false);
      await page.evaluate(() => {
        // 読み込みの表示は、読み込みが終わると透明になる。位置を確かめるため、表示中の状態にする。
        document.querySelector<HTMLElement>('.ptm-loading')!.dataset.state = 'loading';
      });
      const loading = (await rectOf(page, '.ptm-loading'))!;
      expect(overlaps(panel, loading), 'パネルと読み込みの表示').toBe(false);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('.ptm-loading')!.dataset.state = 'idle';
      });
      expect(await visibleCards(page)).toEqual([]);

      // 文字がパネルの中で切れていない（スクロールの要る中身がない）。
      expect(await page.evaluate(() => {
        const p = document.querySelector<HTMLElement>('.ptm-cover__panel')!;
        return p.scrollHeight - p.clientHeight;
      })).toBeLessThanOrEqual(0);

      mkdirSync('screenshots/cover', { recursive: true });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `screenshots/cover/${size.name}-cover.png` });

      // 表紙から場面1へ移る途中: カードは表紙のパネルの下にあり、重ならない。
      // 読み込みの表示と横に重なる配置では、パネルは読み込みの表示に届く前に消える。
      for (const f of [0.25, 0.5, 0.75]) {
        await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), Math.round(coverHeight * f));
        await nextFrames(page);
        const p = await rectOf(page, '.ptm-cover__panel');
        const alpha = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.ptm-cover__panel')!).opacity));
        for (const c of await visibleCards(page)) {
          if (p && alpha > 0.05) expect(overlaps(p, c), `scroll=${f}`).toBe(false);
        }
        if (p && alpha > 0.05) expect(overlaps(p, loading), `scroll=${f} 読み込みの表示`).toBe(false);
        expect(await page.evaluate(() => window.__MAIN__!.getState().stage)).toBe(0);
        if (f !== 0.75) {
          await page.waitForTimeout(300);
          await page.screenshot({ path: `screenshots/cover/${size.name}-transition-${Math.round(f * 100)}.png` });
        }
      }

      // 表紙を過ぎると、場面1の最初のカードが止まる位置にあり、表紙は見えなくなっている。
      await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), coverHeight);
      await nextFrames(page);
      const cards = await visibleCards(page);
      expect(cards.length).toBeGreaterThanOrEqual(1);
      await expect(page.locator('.story-step').first().locator('.story-card').first()).toBeInViewport();
      await expect(page.locator('.story-step').first().locator('.story-card').first()).toContainText('01 / 08');
      const panelAfter = (await rectOf(page, '.ptm-cover__panel'))!;
      const alphaAfter = Number(await page.evaluate(() => getComputedStyle(document.querySelector('.ptm-cover__panel')!).opacity));
      expect(panelAfter.bottom <= 0 || alphaAfter <= 0.05, '表紙は見えなくなっている').toBe(true);

      // 「データと方法」の節の「作品の先頭へ戻る」で表紙へ戻る。
      await page.evaluate(() => document.getElementById('data-and-methods')!.scrollIntoView({ behavior: 'instant' }));
      await page.locator('#data-and-methods a[href="#top"]').first().click();
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
      await expect(page.locator('.ptm-cover__panel')).toBeInViewport();
      await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage)).toBe(0);

      expect(errors).toEqual([]);
    });
  });
}

test.describe('表紙と、レイアウトの計算し直し・フォーカス・ページ内リンク', () => {
  const waitReady = (page: Page): Promise<unknown> =>
    page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 150_000 });
  const firstStart = (page: Page): Promise<number> => page.evaluate(() => window.__MAIN__!.scrollYFor(0, 0));
  const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

  test('リサイズ・回転で、場面1の始まりにいる読者は場面1の始まりに、表紙の途中にいる読者は表紙の同じ割合に戻る', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/');
    await waitReady(page);

    // 「スクロールして読む」で場面1の始まりへ移り、縦向きへ変える。
    await page.locator('.ptm-cover__cue').click();
    await expect.poll(async () => Math.abs((await scrollY(page)) - (await firstStart(page)))).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => firstStart(page)).toBeGreaterThan(800);
    await expect.poll(async () => Math.abs((await scrollY(page)) - (await firstStart(page))), { timeout: 10_000 }).toBeLessThanOrEqual(1);
    await page.waitForTimeout(500);
    expect(Math.abs((await scrollY(page)) - (await firstStart(page)))).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.__MAIN__!.getState())).toMatchObject({ stage: 0, progress: 0 });

    // 表紙の途中（半分）で横向きへ変えると、表紙の半分の位置に戻る。
    await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), Math.round((await firstStart(page)) * 0.5));
    await nextFrames(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => firstStart(page)).toBeLessThan(400);
    await page.waitForTimeout(800);
    const ratio = (await scrollY(page)) / (await firstStart(page));
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
    expect(errors).toEqual([]);
  });

  test('薄くして消した表紙のパネルも、中にフォーカスがある間は不透明で出る（縦向きのスマートフォン）', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await waitReady(page);
    const opacity = (): Promise<number> =>
      page.evaluate(() => Number(getComputedStyle(document.querySelector('.ptm-cover__panel')!).opacity));
    // 読み込みの表示と横に重なる配置なので、パネルの上端が届く前に消える位置へ移る。
    const panelTop = (await rectOf(page, '.ptm-cover__panel'))!.top;
    await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), Math.round(panelTop));
    await nextFrames(page);
    expect(await opacity()).toBeLessThanOrEqual(0.05);
    await page.evaluate(() => document.querySelector<HTMLElement>('.ptm-cover__cue')!.focus({ preventScroll: true }));
    await expect.poll(opacity).toBe(1);
    await page.evaluate(() => document.querySelector<HTMLElement>('.ptm-cover__cue')!.blur());
    await expect.poll(opacity).toBeLessThanOrEqual(0.05);
    expect(errors).toEqual([]);
  });

  for (const size of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    test(`#data-and-methods 付きの URL で開くと「データと方法」の節に着く（${size.width}×${size.height}）`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.setViewportSize(size);
      await page.goto('/#data-and-methods');
      await waitReady(page);
      // フォントの読み込み後などの計算し直しの後も、節の先頭にいる。
      await page.waitForTimeout(1500);
      const top = await page.evaluate(() => document.getElementById('data-and-methods')!.getBoundingClientRect().top);
      expect(Math.abs(top)).toBeLessThanOrEqual(2);
      await expect(page.locator('#data-and-methods h2')).toBeInViewport();
      expect(errors).toEqual([]);
    });
  }
});
