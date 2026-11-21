/**
 * 本編: 8場面を順にスクロールし、場面の番号・カメラの注視点・コンソールエラーを確かめ、各場面のスクリーンショットを撮る。
 * 秋葉原の場面（1・2・8）では、表示中の自転車の台数（場面1 で 1台、場面2 の途中と終わり、場面8 で 462台）を確かめる。
 * 場面ごとに、切り替えてから街並みが出そろうまでの時間と、その間に読み込んだ量を screenshots/main-metrics*.json に書き出す。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCRIPT } from '../../src/story/content/script';
import { freeRegionFor } from '../../src/story/layout';

// ソフトウェア描画（SwiftShader）では PLATEAU の読み込みと描画に時間がかかる
test.setTimeout(1_500_000);

// 地上の目線の場面（1・8）は、航空写真の細かいタイルの読み込みに 2〜4 分かかる（ほかのテストと並行して動くとき）
const SETTLE_TIMEOUT_MS = 420_000;

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

/**
 * 場面 i の、カメラが止まっていて本文カードが画面の中ほどにある位置へスクロールし、出そろうのを待つ。
 * holdFraction は、カメラが止まっている区間のどこへ行くか（既定 0.5 = 真ん中）。
 */
async function goToScene(page: Page, i: number, holdFraction = 0.5): Promise<number> {
  const t0 = Date.now();
  await page.evaluate(
    ([i, f]) => {
      const api = window.__MAIN__!;
      const hold = api.holds()[i] ?? 0.4;
      window.scrollTo({ top: api.scrollYFor(i, hold * f), behavior: 'instant' });
    },
    [i, holdFraction] as const,
  );
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

/** 秋葉原の自転車の表示中の台数。 */
async function akihabaraShown(page: Page): Promise<number> {
  return page.evaluate(() => window.__AKIHABARA__?.shown ?? -1);
}

/** 秋葉原の場面の表示中の台数（場面 id → 台数）。場面2 はカメラが止まっている区間の終わり近くで数える。 */
const AKIHABARA_SHOWN: Record<string, number> = { 'akihabara-one': 1, 'akihabara-462': 462, 'since-1990': 462 };

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
    if (scene.id === 'akihabara-462') {
      // 場面2 の途中（台数が増えている途中）。台数は 1 と 462 の間で、表示の工夫（足元の印）が見えている。
      await goToScene(page, i, 0.42);
      const half = await akihabaraShown(page);
      expect(half).toBeGreaterThan(150);
      expect(half).toBeLessThan(400);
      expect(await page.evaluate(() => window.__AKIHABARA__!.markerOpacity)).toBeGreaterThan(0.9);
      await page.screenshot({ path: 'screenshots/main-2-half.png' });
    }
    const holdFraction = scene.id === 'akihabara-462' ? 0.95 : 0.5;
    const settleMs = i === 0 ? (await goToScene(page, i, holdFraction), Date.now() - tOpen) : await goToScene(page, i, holdFraction);
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

    // 秋葉原の自転車の台数（ほかの場面では描かない）
    const expected = AKIHABARA_SHOWN[scene.id] ?? 0;
    expect(await akihabaraShown(page), `場面${i + 1} ${scene.id} の自転車の台数`).toBe(expected);
    if (expected > 0) {
      const info = await page.evaluate(() => window.__AKIHABARA__!);
      expect(info.total).toBe(462);
      expect(info.onGround + info.underBridge).toBe(462);
      expect(info.maxDistanceM).toBeLessThanOrEqual(500);
      // 増えた分の印が光り終わってから撮る
      await page.waitForTimeout(2500);
    }

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

test('スマートフォン幅（390×844）で場面1・2・5が読める', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  await open(page);
  for (const i of [0, 1, 4]) {
    const id = SCRIPT[i]!.id;
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
    // 秋葉原の自転車の表示中の台数（場面2 はカメラが止まっている区間の終わり近くで数える）
    await goToScene(page, i, id === 'akihabara-462' ? 0.95 : 0.5);
    expect(await akihabaraShown(page)).toBe(AKIHABARA_SHOWN[id] ?? 0);
    if (AKIHABARA_SHOWN[id]) await page.waitForTimeout(2500);
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

// ---------------------------------------------------------------------------
// 場面3・4（都内の駅ごとの放置自転車。489か所の柱）
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const hit = (a: Box, b: Box): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** 場面 i の、進捗が「カメラが止まっている区間 × frac」の位置へスクロールし、描画が落ち着くのを待つ。 */
async function goToStationScene(page: Page, i: number, frac: number): Promise<void> {
  await page.evaluate(
    ([i, frac]) => {
      const api = window.__MAIN__!;
      const hold = api.holds()[i!] ?? 0.4;
      window.scrollTo({ top: api.scrollYFor(i!, hold * frac!), behavior: 'instant' });
    },
    [i, frac],
  );
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage)).toBe(i);
  await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
  // 表示・色の切り替えのアニメーションが終わるのを待つ
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__STATIONS_MAIN__!.read();
        const target = s.active === 'parking-vacancy' ? 1 : 0;
        return s.visibility === 1 && s.colorBlend === target;
      }),
    )
    .toBe(true);
  await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
}

/** いま画面に出ているラベルと凡例の長方形。 */
async function overlayBoxes(page: Page): Promise<{ labels: { name: string; box: Box }[]; legend: Box }> {
  return page.evaluate(() => {
    const labels: { name: string; box: Box }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.sm-label')) {
      if (getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      labels.push({ name: el.querySelector('.sm-label-name')!.textContent ?? '', box: { x: r.x, y: r.y, width: r.width, height: r.height } });
    }
    const l = document.querySelector('.sm-legend')!.getBoundingClientRect();
    return { labels, legend: { x: l.x, y: l.y, width: l.width, height: l.height } };
  });
}

/** ラベルと凡例が、画面内で、互いに・見えている本文カードに重ならず、出典表示にも重ならない。ラベルの数を返す。 */
async function expectOverlayClear(page: Page, viewport: { width: number; height: number }): Promise<number> {
  const { labels, legend } = await overlayBoxes(page);
  const cards = await visibleCards(page);
  const attribution = (await page.locator('.ptm-site-attribution').boundingBox())!;
  const covers: Box[] = [...cards, attribution];
  const all = [...labels.map((l) => l.box), legend];
  for (const b of all) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
    expect(b.y + b.height).toBeLessThanOrEqual(viewport.height);
    for (const c of covers) expect(hit(b, c), `重なり ${JSON.stringify(b)} と ${JSON.stringify(c)}`).toBe(false);
  }
  for (let i = 0; i < labels.length; i++) {
    expect(hit(labels[i]!.box, legend)).toBe(false);
    for (let j = i + 1; j < labels.length; j++) expect(hit(labels[i]!.box, labels[j]!.box)).toBe(false);
  }
  return labels.length;
}

interface ScreenStation {
  name: string;
  municipality: string;
  lat: number;
  lon: number;
  bicycles: number;
  base: { x: number; y: number };
  top: { x: number; y: number };
}

/** 本文カードに覆われていない範囲（画面の座標）。アプリが使う `freeRegionFor` を、いまのカードの位置から求める。 */
async function freeRegion(page: Page): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const info = await page.evaluate(() => {
    let columnRight = 0;
    let coverTop = Number.POSITIVE_INFINITY;
    for (const card of document.querySelectorAll<HTMLElement>('.story-card')) {
      columnRight = Math.max(columnRight, card.getBoundingClientRect().right);
      const top = Number.parseFloat(getComputedStyle(card).top);
      if (Number.isFinite(top)) coverTop = Math.min(coverTop, top);
    }
    const story = document.querySelector('.story')!;
    return {
      side: getComputedStyle(story).getPropertyValue('--story-layout').trim() === 'side',
      width: window.innerWidth,
      height: window.innerHeight,
      columnRight,
      coverTop: Number.isFinite(coverTop) ? coverTop : window.innerHeight,
    };
  });
  return freeRegionFor({
    layout: info.side ? 'side' : 'bottom',
    width: info.width,
    height: info.height,
    visibleHeight: info.height,
    columnRight: info.columnRight,
    coverTop: info.coverTop,
  });
}

const stationScreen = (page: Page): Promise<ScreenStation[]> => page.evaluate(() => window.__STATIONS_MAIN__!.screen());

/**
 * 23区の駅の柱が、本文カードに覆われていない範囲に収まっている。台数の上位40駅と、23区の外周（東西南北の端の各3駅）は、
 * 柱の底も頂点もすべて入り、23区の駅の95%以上は柱の底が入る。
 */
async function expectWardsInFreeRegion(page: Page): Promise<void> {
  const r = await freeRegion(page);
  const inside = (p: { x: number; y: number }): boolean => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  const wards = (await stationScreen(page)).filter((s) => s.municipality.endsWith('区'));
  expect(wards.length).toBeGreaterThan(300);
  const byBicycles = [...wards].sort((a, b) => b.bicycles - a.bicycles).slice(0, 40);
  const byLon = [...wards].sort((a, b) => a.lon - b.lon);
  const byLat = [...wards].sort((a, b) => a.lat - b.lat);
  const outer = [...byLon.slice(0, 3), ...byLon.slice(-3), ...byLat.slice(0, 3), ...byLat.slice(-3)];
  for (const s of [...byBicycles, ...outer]) {
    expect(inside(s.base), `${s.name}（${s.bicycles}台）の柱の底が範囲外 ${JSON.stringify(s.base)} / ${JSON.stringify(r)}`).toBe(true);
    expect(inside(s.top), `${s.name}（${s.bicycles}台）の柱の頂点が範囲外 ${JSON.stringify(s.top)} / ${JSON.stringify(r)}`).toBe(true);
  }
  expect(wards.filter((s) => inside(s.base)).length / wards.length).toBeGreaterThanOrEqual(0.95);
}

/** 凡例が、23区の駅の柱（底から頂点まで）を隠していない。 */
async function expectLegendClearOfPillars(page: Page): Promise<void> {
  const legend = (await overlayBoxes(page)).legend;
  const wards = (await stationScreen(page)).filter((s) => s.municipality.endsWith('区'));
  const hidden = wards.filter((s) =>
    [0, 0.25, 0.5, 0.75, 1].some((t) => {
      const x = s.base.x + (s.top.x - s.base.x) * t;
      const y = s.base.y + (s.top.y - s.base.y) * t;
      return x >= legend.x && x <= legend.x + legend.width && y >= legend.y && y <= legend.y + legend.height;
    }),
  );
  expect(hidden.map((s) => `${s.name}（${s.bicycles}台）`)).toEqual([]);
}

/** 背景の空の色（`createApp` の skyColor）で描かれている画素の数。航空写真・単色の地面が敷かれていれば、俯瞰の画面には現れない。 */
async function skyColoredPixels(page: Page): Promise<number> {
  const png = await page.screenshot();
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i]! - 0xbf) <= 2 && Math.abs(data[i + 1]! - 0xd9) <= 2 && Math.abs(data[i + 2]! - 0xee) <= 2) n++;
    }
    return n;
  }, png.toString('base64'));
}

const LEGEND_SCALE = '柱の高さ 1km ＝ 50台';
const LEGEND_SURVEY = '2025年10月、晴天の平日の午前11時頃に数えた台数';

test('場面3・4（PC 幅）: 柱が伸びて489か所・合計13,394台が立ち、場面4で色分けが切り替わり、場面を離れると消える', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const read = (): Promise<{ sites: number; total: number; growth: number; visibility: number; colorBlend: number; active: string | null; labels: number }> =>
    page.evaluate(() => window.__STATIONS_MAIN__!.read());

  // 場面3: 進捗に合わせて柱が伸びている途中（ラベルはまだ出ない）
  await goToStationScene(page, 2, 0.04);
  const early = await read();
  expect(early.growth).toBeLessThan(0.1);
  await goToStationScene(page, 2, 0.3);
  const growing = await read();
  expect(growing.sites).toBe(489);
  expect(growing.total).toBe(13_394);
  expect(growing.growth).toBeGreaterThan(0.2);
  expect(growing.growth).toBeLessThan(0.8);
  expect(growing.growth).toBeGreaterThan(early.growth);
  await page.screenshot({ path: 'screenshots/main-3-growing.png' });

  // カメラが止まっている区間の中で、伸びきる
  await goToStationScene(page, 2, 0.8);
  const grown = await read();
  expect(grown.growth).toBe(1);
  expect(grown.active).toBe('tokyo-13394');
  const legend = page.locator('.sm-legend');
  await expect(legend).toContainText('合計 13,394台（489か所）');
  await expect(legend).toContainText(LEGEND_SURVEY);
  await expect(page.locator('.sm-legend-scale')).toHaveText(LEGEND_SCALE);
  await expect(page.locator('.sm-legend-steps:not(.sm-legend-vacancy)')).toBeVisible();
  await expect(page.locator('.sm-legend-vacancy')).toBeHidden();
  const vp = { width: 1280, height: 720 };
  const labelCount = await expectOverlayClear(page, vp);
  expect(labelCount).toBeGreaterThanOrEqual(8);
  const { labels } = await overlayBoxes(page);
  expect(labels.map((l) => l.name)).toContain('秋葉原');
  expect(labels.map((l) => l.name)).toContain('東京・大手町ほか');
  // ラベルは本文カードの列の右側（カードに覆われていない範囲）にある
  const columnRight = Math.max(...(await page.evaluate(() => [...document.querySelectorAll('.story-card')].map((c) => c.getBoundingClientRect().right))));
  for (const l of labels) expect(l.box.x).toBeGreaterThan(columnRight);
  // 凡例は範囲の左上の隅（地図の上側の余白）に、横に長い形で置かれ、23区の駅の柱を隠さない
  const legendBox = (await overlayBoxes(page)).legend;
  expect(legendBox.x).toBeGreaterThan(columnRight);
  expect(legendBox.y).toBeLessThan(30);
  expect(legendBox.height).toBeLessThan(170);
  await expectLegendClearOfPillars(page);
  // 23区の駅の柱の大半が、本文カードに覆われていない範囲に収まる
  await expectWardsInFreeRegion(page);
  // 航空写真のない範囲も単色の地面で埋まり、空の色で抜けた範囲がない
  expect(await skyColoredPixels(page)).toBeLessThan(200);
  await page.screenshot({ path: 'screenshots/main-3.png' });

  // 場面4: 柱は伸びきったまま、色分けが「空きが放置台数以上／未満」に切り替わる
  await goToStationScene(page, 3, 0.5);
  const vacancy = await read();
  expect(vacancy).toMatchObject({ sites: 489, total: 13_394, growth: 1, colorBlend: 1, active: 'parking-vacancy' });
  await expect(page.locator('.sm-legend-vacancy')).toBeVisible();
  await expect(page.locator('.sm-legend-vacancy')).toContainText('駐輪場の空きが放置台数以上');
  await expect(page.locator('.sm-legend-vacancy')).toContainText('駐輪場の空きが放置台数未満');
  await expect(page.locator('.sm-legend-steps:not(.sm-legend-vacancy)')).toBeHidden();
  await expect(legend).toContainText('合計 13,394台（489か所）');
  await expect(legend).toContainText(LEGEND_SURVEY);
  expect(await expectOverlayClear(page, vp)).toBeGreaterThanOrEqual(8);
  await expectLegendClearOfPillars(page);
  await expectWardsInFreeRegion(page);
  expect(await skyColoredPixels(page)).toBeLessThan(200);
  await page.screenshot({ path: 'screenshots/main-4.png' });

  // 場面4から場面3へ戻っても、柱は伸びきったまま（色は台数の段階に戻る）
  await goToStationScene(page, 2, 0.8);
  expect(await read()).toMatchObject({ growth: 1, colorBlend: 0, active: 'tokyo-13394' });

  // 場面を離れる（場面2へ戻る）と、柱・ラベル・凡例は消える
  await page.evaluate(() => window.scrollTo({ top: window.__MAIN__!.scrollYFor(1, 0.3), behavior: 'instant' }));
  await expect.poll(async () => (await read()).visibility, { timeout: 15_000 }).toBe(0);
  await expect(legend).toBeHidden();
  expect(errors).toEqual([]);
});

test('場面3・4（スマートフォン幅 390×844）: ラベルは上位5か所以内で、凡例とともに画面の上側に収まり、本文カードと重ならない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  await open(page);
  const vp = { width: 390, height: 844 };

  for (const [i, file] of [
    [2, 'screenshots/main-mobile-3.png'],
    [3, 'screenshots/main-mobile-4.png'],
  ] as const) {
    // カードが出ている位置を含む複数の位置で、ラベル・凡例がカードに重ならない
    for (const frac of [0.01, 0.4, 0.95]) {
      await goToStationScene(page, i, frac);
      const n = await expectOverlayClear(page, vp);
      expect(n).toBeLessThanOrEqual(5);
      const { labels, legend } = await overlayBoxes(page);
      // 凡例は画面の上側の隅に小さく置かれる
      expect(legend.y).toBeLessThan(40);
      expect(legend.x).toBeLessThan(20);
      expect(legend.width).toBeLessThan(260);
      expect(legend.y + legend.height).toBeLessThan(844 / 2);
      for (const l of labels) expect(l.box.y + l.box.height).toBeLessThan(844 / 2 + 40);
      // 凡例は23区の駅の柱を隠さず、23区の駅の柱の大半（上位の駅と外周の駅は全部）が、カードに覆われていない範囲に入る
      await expectLegendClearOfPillars(page);
      await expectWardsInFreeRegion(page);
    }
    // 柱が伸びきっていて、本文カードも出ている位置（カードとカードのあいだは何も出ない）でスクリーンショットを撮る
    let withCard = false;
    for (const frac of [0.62, 0.64, 0.88, 0.9, 0.6, 0.32]) {
      await goToStationScene(page, i, frac);
      const growth = await page.evaluate(() => window.__STATIONS_MAIN__!.read().growth);
      if (growth === 1 && (await visibleCards(page)).length > 0) {
        withCard = true;
        break;
      }
    }
    expect(withCard).toBe(true);
    const s = await page.evaluate(() => window.__STATIONS_MAIN__!.read());
    expect(s).toMatchObject({ sites: 489, total: 13_394, growth: 1 });
    expect(await expectOverlayClear(page, vp)).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.sm-legend')).toContainText('合計 13,394台（489か所）');
    await expect(page.locator('.sm-legend')).toContainText(LEGEND_SURVEY);
    await expect(page.locator('.sm-legend-scale')).toHaveText(LEGEND_SCALE);
    expect(await skyColoredPixels(page)).toBeLessThan(200);
    await page.screenshot({ path: file });
  }
  expect(errors).toEqual([]);
});
