import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * 街の上の地名（src/scene/placeLabels.ts）。
 * - 確認ページ: 準備完了・コンソールエラー0件・地名が重ならずに出ること。`screenshots/place-labels.png`。
 * - 本編: 8場面のそれぞれで地名が出て、互いに・本文カード・凡例・駅のラベル・出典表示・主役（自転車・山・柱を画面に投影した
 *   範囲 `keepOutRects`）と重ならず、画面に収まること。地名の矩形は、実際に出ている `.pl-label.is-shown` の要素の矩形で確かめる。
 *   場面の間を移る途中は地名を出さないこと。画面は `screenshots/place-labels/<画面>-<場面の番号>-<id>.png`
 *   （docs/design/place-labels/ の画像はここから選んで写す）。
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const hit = (a: Box, b: Box): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** 出ている地名の要素の矩形（ページの左上が原点。canvas の入れ物は画面いっぱい）。 */
const shownLabelBoxes = (page: Page): Promise<(Box & { name: string })[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.pl-label.is-shown')].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.textContent ?? '', x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

/** 地名が画面に収まり、互いに・障害物と重ならないこと。 */
function expectClear(labels: readonly (Box & { name: string })[], obstacles: readonly Box[], viewport: { width: number; height: number }, tag: string): void {
  for (const l of labels) {
    expect(l.x, `${tag} ${l.name}`).toBeGreaterThanOrEqual(0);
    expect(l.y, `${tag} ${l.name}`).toBeGreaterThanOrEqual(0);
    expect(l.x + l.w, `${tag} ${l.name}`).toBeLessThanOrEqual(viewport.width);
    expect(l.y + l.h, `${tag} ${l.name}`).toBeLessThanOrEqual(viewport.height);
    for (const o of obstacles) expect(hit(l, o), `${tag} ${l.name} と障害物 ${JSON.stringify(o)}`).toBe(false);
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) expect(hit(labels[i]!, labels[j]!), `${tag} ${labels[i]!.name} と ${labels[j]!.name}`).toBe(false);
  }
}

test.describe('確認ページ', () => {
  test.describe.configure({ timeout: 600_000 });
  test.use({ deviceScaleFactor: 1 });

  test('秋葉原の上空で地名が重ならずに出る', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/demos/place-labels.html?scene=since-1990');
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__PLACE_LABELS_DEMO__!.shown().length), { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    // 出入りの不透明度の切り替えが終わるのを待つ
    await page.waitForTimeout(800);
    const shown = await shownLabelBoxes(page);
    expect(shown.length).toBeGreaterThanOrEqual(3);
    expectClear(shown, [], page.viewportSize()!, 'demo');
    // 地名はスクリーンリーダーに読ませない（装飾）
    await expect(page.locator('.pl-overlay')).toHaveAttribute('aria-hidden', 'true');
    await page.screenshot({ path: 'screenshots/place-labels.png' });
    expect(errors).toEqual([]);
  });
});

const SETTLE_TIMEOUT_MS = 1_200_000;

async function goToScene(page: Page, i: number, holdFraction = 0.5): Promise<void> {
  await page.evaluate(
    ([i, f]) => {
      const api = window.__MAIN__!;
      const hold = api.holds()[i] ?? 0.4;
      window.scrollTo({ top: api.scrollYFor(i, hold * f), behavior: 'instant' });
    },
    [i, holdFraction] as const,
  );
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage), { timeout: 120_000 }).toBe(i);
  await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
  // 地名の出入り（不透明度の切り替え 320ms）と、駅の柱の表示の切り替え（0.35 秒）が終わるのを待つ
  await page.waitForTimeout(900);
}

interface Shown {
  scene: string | null;
  labels: (Box & { name: string })[];
  obstacles: Box[];
  keepOut: Box[];
}

const readLabels = async (page: Page): Promise<Shown> => {
  const api = await page.evaluate(() => {
    const a = window.__PLACE_LABELS__!;
    return { scene: a.scene(), obstacles: a.obstacles(), keepOut: a.keepOut().map((r) => ({ ...r })), count: a.shown().length };
  });
  const labels = await shownLabelBoxes(page);
  // 内部の一覧と、画面に出ている要素の数が合う
  expect(labels.length).toBe(api.count);
  return { scene: api.scene, labels, obstacles: api.obstacles, keepOut: api.keepOut };
};

const VIEWPORTS = [
  { name: 'pc', width: 1280, height: 720, scenes: [0, 1, 2, 3, 4, 5, 6, 7] },
  { name: 'phone', width: 390, height: 844, scenes: [0, 1, 2, 3, 4, 5, 6, 7] },
  { name: 'w320', width: 320, height: 568, scenes: [1, 2, 4, 5] },
] as const;

test.describe('本編の地名', () => {
  test.describe.configure({ timeout: 3 * 60 * 60 * 1000 });
  test.use({ deviceScaleFactor: 1 });

  for (const vp of VIEWPORTS) {
    test(`${vp.name}（${vp.width}×${vp.height}）: 場面ごとの地名が読める`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 180_000 });
      const ids = await page.evaluate(() => window.__MAIN__!.stageIds());
      mkdirSync('screenshots/place-labels', { recursive: true });
      const summary: Record<string, string[]> = {};
      for (const i of vp.scenes) {
        await goToScene(page, i);
        const s = await readLabels(page);
        expect(s.scene).toBe(ids[i]);
        expect(s.labels.length, `${vp.name} 場面${i + 1} の地名`).toBeGreaterThanOrEqual(1);
        expectClear(s.labels, [...s.obstacles, ...s.keepOut], { width: vp.width, height: vp.height }, `${vp.name} 場面${i + 1}`);
        summary[`${i + 1} ${ids[i]}`] = s.labels.map((l) => l.name);
        await page.screenshot({ path: `screenshots/place-labels/${vp.name}-${i + 1}-${ids[i]}.png` });
      }
      console.log(vp.name, JSON.stringify(summary));
      expect(errors).toEqual([]);
    });
  }

  test('止まっているあいだは置き直さず、場面の間を移る途中は地名を出さない', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 180_000 });
    await goToScene(page, 1);
    expect((await readLabels(page)).labels.length).toBeGreaterThan(0);
    // カメラもスクロールも変わらないあいだは、地名を置き直さない（DOM を読まない）
    const before = await page.evaluate(() => window.__PLACE_LABELS__!.updates());
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__PLACE_LABELS__!.updates())).toBe(before);
    // 場面2 の、カメラが止まっている区間の後（場面3 へ移る途中）
    await page.evaluate(() => {
      const api = window.__MAIN__!;
      const hold = api.holds()[1] ?? 0.4;
      window.scrollTo({ top: api.scrollYFor(1, hold + (1 - hold) * 0.5), behavior: 'instant' });
    });
    // 場面は null、内部の一覧も画面の要素も 0 件。落ちたときに状態が分かるよう、まとめて読む
    const transit = (): Promise<string> =>
      page.evaluate(() => {
        const api = window.__PLACE_LABELS__!;
        const st = window.__MAIN__!.getState();
        const els = [...document.querySelectorAll('.pl-label.is-shown')].map((e) => e.textContent);
        return JSON.stringify({ scene: api.scene(), shown: api.shown().length, elements: els, stage: st.stage, progress: Number(st.progress.toFixed(3)) });
      });
    await expect
      .poll(transit, { timeout: 30_000 })
      .toMatch(/"scene":null,"shown":0,"elements":\[\]/);
    expect(errors).toEqual([]);
  });
});
