/**
 * 本編: 8場面を順にスクロールし、場面の番号・カメラの注視点・コンソールエラーを確かめ、各場面のスクリーンショットを撮る。
 * 場面ごとに、切り替えてから街並みが出そろうまでの時間と、その間に読み込んだ量を screenshots/main-metrics*.json に書き出す。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCRIPT } from '../../src/story/content/script';
import { checkPileScene, PILE_SCENES, type PileMetric } from './pileHelpers';

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
  await expect(page.locator('.story-card')).toHaveCount(SCRIPT.length);

  // 出典表示（2行、語ごとのリンク、ページ内リンク）
  const attribution = page.locator('.ptm-site-attribution');
  await expect(attribution).toContainText('出典：国土交通省 PLATEAU・国土地理院・国土数値情報・東京都のデータを加工して作成');
  await expect(attribution).toContainText('非公式の作品｜データと方法');
  await expect(attribution.getByRole('link', { name: '国土交通省 PLATEAU' })).toHaveAttribute('href', 'https://www.mlit.go.jp/plateau/');
  await expect(attribution.getByRole('link', { name: 'データと方法' })).toHaveAttribute('href', '#data-and-methods');
  await expect(page.locator('#data-and-methods')).toContainText('準備中');

  const metrics: SceneMetric[] = [];
  const pileMetrics: PileMetric[] = [];
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

    // 山の場面（5・6・7）: 降って積もり、実数に達する
    if (PILE_SCENES[i]) pileMetrics.push(await checkPileScene(page, i, '1280x720', i === 4 ? 'screenshots/main-5-falling.png' : undefined));

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
  writeFileSync('screenshots/main-piles-metrics.json', JSON.stringify(pileMetrics, null, 2));
  for (const m of pileMetrics) console.log(`場面${m.scene} 山 ${m.key}: ${m.triangles.toLocaleString('en-US')} 三角形（${m.profile}）`);
  for (const m of metrics) {
    console.log(`場面${m.scene} ${m.id}: ${(m.bytes / 1e6).toFixed(1)} MB, ${(m.settleMs / 1000).toFixed(1)} s`);
  }
  expect(errors).toEqual([]);
});

test('スマートフォン幅（390×844）で場面2・5・6が読める', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  const pileMetrics: PileMetric[] = [];
  await open(page);
  for (const i of [1, 4, 5]) {
    await goToScene(page, i);
    const card = page.locator('.story-card').nth(i);
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    // カードが画面の幅に収まり、画面の中に入っている
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    if (PILE_SCENES[i]) {
      const m = await checkPileScene(page, i, '390x844');
      // 画面の短辺が 600px 以下なのでスマートフォン向けの設定になる
      expect(m.profile).toBe('small');
      pileMetrics.push(m);
    }
    await page.screenshot({ path: `screenshots/main-mobile-${i + 1}.png` });
  }
  // 出典のリンクがタップできる大きさ（高さ 24px 以上）
  const link = page.locator('.ptm-site-attribution a').first();
  const lb = await link.boundingBox();
  expect(lb!.height).toBeGreaterThanOrEqual(24);
  mkdirSync('screenshots', { recursive: true });
  writeFileSync('screenshots/main-piles-metrics-mobile.json', JSON.stringify(pileMetrics, null, 2));
  for (const m of pileMetrics) console.log(`場面${m.scene} 山 ${m.key}（スマートフォン）: ${m.triangles.toLocaleString('en-US')} 三角形`);
  expect(errors).toEqual([]);
});
