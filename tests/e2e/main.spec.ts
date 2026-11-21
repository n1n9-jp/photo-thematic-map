/**
 * 本編: 8場面を順にスクロールし、場面の番号・カメラの注視点・コンソールエラーを確かめ、各場面のスクリーンショットを撮る。
 * 場面ごとに、切り替えてから街並みが出そろうまでの時間と、その間に読み込んだ量を screenshots/main-metrics*.json に書き出す。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCRIPT } from '../../src/story/content/script';

// ソフトウェア描画（SwiftShader）では PLATEAU の読み込みと描画に時間がかかる
test.setTimeout(1_500_000);

const SETTLE_TIMEOUT_MS = 240_000;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

/** 読み込んだ量（応答の本文とヘッダーのバイト数）を数える。 */
function countBytes(page: Page): { total: () => number } {
  let bytes = 0;
  page.on('requestfinished', (req) => {
    void req
      .sizes()
      .then((s) => {
        bytes += s.responseBodySize + s.responseHeadersSize;
      })
      .catch(() => undefined);
  });
  return { total: () => bytes };
}

/** 地表の距離(m)の近似。 */
function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dy = (a.lat - b.lat) * 111_000;
  const dx = (a.lon - b.lon) * 111_000 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });
}

/** 場面 i の、カメラが止まっていて本文カードが画面の中ほどにある位置へスクロールし、出そろうのを待つ。 */
async function goToScene(page: Page, i: number): Promise<number> {
  const t0 = Date.now();
  await page.evaluate((i) => {
    const api = window.__MAIN__!;
    const hold = api.holds()[i] ?? 0.4;
    window.scrollTo({ top: api.scrollYFor(i, hold * 0.5), behavior: 'instant' });
  }, i);
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage)).toBe(i);
  await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
  return Date.now() - t0;
}

/** 画面に見えているカード（薄くなって消えたものを除く）の長方形。 */
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

interface SceneMetric {
  scene: number;
  id: string;
  settleMs: number;
  bytes: number;
}

test('8場面を順にスクロールすると、場面が進み、カメラが台本の場所へ移る（PC 幅）', async ({ page }) => {
  const errors = collectErrors(page);
  const bytes = countBytes(page);
  const tOpen = Date.now();
  await open(page);
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.story-step')).toHaveCount(SCRIPT.length);

  // 出典表示（2行、語ごとのリンク、ページ内リンク）
  const attribution = page.locator('.ptm-site-attribution');
  await expect(attribution).toContainText('出典：国土交通省 PLATEAU・国土地理院・国土数値情報・東京都のデータを加工して作成');
  await expect(attribution).toContainText('非公式の作品｜データと方法');
  await expect(attribution.getByRole('link', { name: '国土交通省 PLATEAU' })).toHaveAttribute('href', 'https://www.mlit.go.jp/plateau/');
  await expect(attribution.getByRole('link', { name: 'データと方法' })).toHaveAttribute('href', '#data-and-methods');
  await expect(page.locator('#data-and-methods')).toContainText('準備中');

  const metrics: SceneMetric[] = [];
  let before = 0;
  for (let i = 0; i < SCRIPT.length; i++) {
    const scene = SCRIPT[i]!;
    const settleMs = i === 0 ? (await goToScene(page, i), Date.now() - tOpen) : await goToScene(page, i);
    const after = bytes.total();
    metrics.push({ scene: i + 1, id: scene.id, settleMs, bytes: after - before });
    before = after;

    const target = await page.evaluate(() => window.__MAIN__!.target());
    // 注視点は台本の場所（水平 3m 以内）、高さは台本の「地表からの高さ」に合う
    expect(distanceM(target, scene.camera.target)).toBeLessThan(3);
    expect(Math.abs(target.heightAboveGround - (scene.camera.target.alt ?? 0))).toBeLessThan(0.5);
    // カメラは地面の上
    const cam = await page.evaluate(() => window.__MAIN__!.camera());
    expect(cam.heightAboveGround).toBeGreaterThan(0.5);

    await page.screenshot({ path: `screenshots/main-${i + 1}.png` });
  }

  // 最後の場面では「地図を動かす」で自由操作に入れる
  const toggle = page.locator('.story-free-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.status().free)).toBe(true);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.status().free)).toBe(false);

  mkdirSync('screenshots', { recursive: true });
  writeFileSync('screenshots/main-metrics.json', JSON.stringify(metrics, null, 2));
  for (const m of metrics) {
    console.log(`場面${m.scene} ${m.id}: ${(m.bytes / 1e6).toFixed(1)} MB, ${(m.settleMs / 1000).toFixed(1)} s`);
  }
  expect(errors).toEqual([]);
});

test('スマートフォン幅（390×844）で場面2と場面5が読める', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  await open(page);
  for (const i of [1, 4]) {
    await goToScene(page, i);
    // 場面の最初のカードが止まっている位置（カードとカードのあいだは何も出ない）で、カードが画面の幅と高さに収まっている
    await page.evaluate((i) => window.scrollTo({ top: window.__MAIN__!.scrollYFor(i, 0.01), behavior: 'instant' }), i);
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    const boxes = await visibleCards(page);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    await page.screenshot({ path: `screenshots/main-mobile-${i + 1}.png` });
  }
  // 出典のリンクがタップできる大きさ（高さ 24px 以上）
  const link = page.locator('.ptm-site-attribution a').first();
  const lb = await link.boundingBox();
  expect(lb!.height).toBeGreaterThanOrEqual(24);
  expect(errors).toEqual([]);
});

test('スマートフォン幅（390×844）で、場面2・5・6の上半分にカードが重ならず、注視点が上側の範囲にある', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  await open(page);
  for (const i of [1, 4, 5]) {
    await goToScene(page, i);
    // 場面を通して（カメラが止まっている区間の全体）、見えているカードは画面の下半分にある
    const hold = await page.evaluate((i) => window.__MAIN__!.holds()[i] ?? 0.4, i);
    let seen = 0;
    for (let k = 0; k <= 20; k++) {
      await page.evaluate(
        ([i, p]) => window.scrollTo({ top: window.__MAIN__!.scrollYFor(i!, p!), behavior: 'instant' }),
        [i, (hold * k) / 20],
      );
      await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
      for (const c of await visibleCards(page)) {
        seen++;
        expect(c.y, `場面${i + 1} 進捗${((hold * k) / 20).toFixed(2)}`).toBeGreaterThanOrEqual(844 / 2 - 1);
        expect(c.height).toBeLessThanOrEqual(844 * 0.4);
      }
    }
    expect(seen).toBeGreaterThan(0);
    // 注視点（主役）は、カードの通らない上側にある
    await goToScene(page, i);
    const target = await page.evaluate(() => window.__MAIN__!.targetOnScreen());
    expect(target.y).toBeLessThan(844 / 2);
    expect(target.y).toBeGreaterThan(844 * 0.1);
    expect(Math.abs(target.x - 390 / 2)).toBeLessThan(390 * 0.03);
    // 出典表示は画面の下端にあり、カードより下
    const attribution = await page.locator('.ptm-site-attribution').boundingBox();
    expect(attribution!.y + attribution!.height).toBeLessThanOrEqual(844);
    for (const c of await visibleCards(page)) expect(c.y + c.height).toBeLessThanOrEqual(attribution!.y);
    await page.screenshot({ path: `screenshots/main-layout-mobile-${i + 1}.png` });
  }
  expect(errors).toEqual([]);
});

test('PC 幅で、場面5・6の注視点がカードの列の右側にあり、出典表示と「地図を動かす」ボタンが重ならない', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  for (const i of [4, 5, 7]) {
    await goToScene(page, i);
    const cards = await visibleCards(page);
    expect(cards.length).toBeGreaterThan(0);
    const columnRight = Math.max(...(await page.evaluate(() => [...document.querySelectorAll('.story-card')].map((c) => c.getBoundingClientRect().right))));
    const columnWidth = await page.evaluate(() => (document.querySelector('.story-card') as HTMLElement).offsetWidth);
    expect(columnWidth).toBeGreaterThanOrEqual(360);
    expect(columnWidth).toBeLessThanOrEqual(400);
    const target = await page.evaluate(() => window.__MAIN__!.targetOnScreen());
    expect(target.x).toBeGreaterThan(columnRight);
    expect(Math.abs(target.x - (columnRight + 1280) / 2)).toBeLessThan(1280 * 0.08);
    // 出典表示は右下で、カードの列に重ならない
    const attribution = await page.locator('.ptm-site-attribution').boundingBox();
    expect(attribution!.x).toBeGreaterThan(columnRight);
    const toggle = page.locator('.story-free-toggle');
    if (await toggle.isVisible()) {
      const tb = (await toggle.boundingBox())!;
      expect(tb.y + tb.height).toBeLessThanOrEqual(attribution!.y);
    }
    await page.screenshot({ path: `screenshots/main-layout-desktop-${i + 1}.png` });
  }
  expect(errors).toEqual([]);
});
