/**
 * 本編: 8場面を順にスクロールし、場面の番号・カメラの注視点・コンソールエラーを確かめ、各場面のスクリーンショットを撮る。
 * 秋葉原の場面（1・2・8）では、表示中の自転車の台数（場面1 で 1台、場面2 の途中と終わり、場面8 で 462台）を確かめる。
 * 場面ごとに、切り替えてから街並みが出そろうまでの時間と、その間に読み込んだ量を screenshots/main-metrics*.json に書き出す。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCRIPT } from '../../src/story/content/script';
import { freeRegionFor } from '../../src/story/layout';
import { checkPileScene, PILE_SCENES, settlePile, type PileMetric } from './pileHelpers';
import { BuildingSolids } from './buildingSolids';
import { measureScene, VISIBILITY_GOALS, type ScenePhase, type VisibilityRow } from './visibilityHelpers';

// ソフトウェア描画（SwiftShader）では PLATEAU の読み込みと描画に時間がかかる
test.setTimeout(5_400_000);

// 地上の目線の場面（1・8）は航空写真の細かいタイルの読み込みに、山の場面（5・6・7）は山と街並みの描画に時間がかかる。
// ソフトウェア描画で、ほかの E2E と並行して動くと 10 分を超えることがある。
const SETTLE_TIMEOUT_MS = 1_200_000;

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
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage), { timeout: 120_000 }).toBe(i);
  // スクロールの進捗が反映されるまで待つ（街並みがすぐ出そろうと、反映の前に isSettled() が true になることがある）
  // 1 フレームが数秒かかる環境（上空から街を広く見る場面）でも待てるよう、場面の番号の確認と同じく 2 分待つ
  await expect
    .poll(() => page.evaluate(([i, f]) => Math.abs(window.__MAIN__!.getState().progress - (window.__MAIN__!.holds()[i] ?? 0.4) * f), [i, holdFraction] as const), {
      timeout: 120_000,
    })
    .toBeLessThan(0.01);
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
  await expect(page.locator('#data-and-methods h2')).toHaveText('データと方法');

  const metrics: SceneMetric[] = [];
  const pileMetrics: PileMetric[] = [];
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
    // 注視点は台本の場所（水平 3m 以内）、高さは台本の「地表からの高さ」に合う。場面の中でカメラが動く場面（場面2）は、
    // 測った位置（カメラが止まっている区間 × holdFraction）より前の最後の経由点（場面の終わりのカメラ）
    const stop = [...(scene.camera.stops ?? [])].reverse().find((st) => st.at <= holdFraction);
    const expectedTarget = stop?.camera.target ?? scene.camera.target;
    expect(distanceM(target, expectedTarget)).toBeLessThan(3);
    expect(Math.abs(target.heightAboveGround - (expectedTarget.alt ?? 0))).toBeLessThan(0.5);
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
    // 山の場面（5・6・7）: 降って積もり、実数に達する
    if (PILE_SCENES[i]) pileMetrics.push(await checkPileScene(page, i, '1280x720', i === 4 ? 'screenshots/main-5-falling.png' : undefined));

    await page.screenshot({ path: `screenshots/main-${i + 1}.png` });
  }

  // 最後の場面では「地図を動かす」で自由操作に入れる
  const toggle = page.locator('.story-free-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.status().free), { timeout: 120_000 }).toBe(true);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.status().free), { timeout: 120_000 }).toBe(false);

  mkdirSync('screenshots', { recursive: true });
  writeFileSync('screenshots/main-metrics.json', JSON.stringify(metrics, null, 2));
  writeFileSync('screenshots/main-piles-metrics.json', JSON.stringify(pileMetrics, null, 2));
  for (const m of pileMetrics) console.log(`場面${m.scene} 山 ${m.key}: ${m.triangles.toLocaleString('en-US')} 三角形（${m.profile}）`);
  for (const m of metrics) {
    console.log(`場面${m.scene} ${m.id}: ${(m.bytes / 1e6).toFixed(1)} MB, ${(m.settleMs / 1000).toFixed(1)} s`);
  }
  expect(errors).toEqual([]);
});

test('スマートフォン幅（390×844）で場面1・2・5・6が読める', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  const pileMetrics: PileMetric[] = [];
  await open(page);
  for (const i of [0, 1, 4, 5]) {
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
// 主役（自転車・山）の見えている割合（場面1・2・5・6・7・8）
// ---------------------------------------------------------------------------

/** 見えている割合を測る場面（0 始まり）。 */
const VISIBILITY_SCENES = SCRIPT.flatMap((s, i) => (Object.keys(VISIBILITY_GOALS).some((k) => k === s.id || k.startsWith(`${s.id}@`)) ? [i] : []));

/**
 * 場面2（462台）の測る位置: カメラが止まっている区間に対する割合。始まり（1台）、途中（駅の東が加わった直後・増えている途中）、
 * 終わり（462台）。
 */
const AKIHABARA_PHASES: { phase: ScenePhase; fraction: number; shot: string }[] = [
  { phase: 'start', fraction: 0.0005, shot: '-start' },
  { phase: 'mid', fraction: 0.05, shot: '-mid-1' },
  { phase: 'mid', fraction: 0.3, shot: '-mid' },
  { phase: 'mid', fraction: 0.6, shot: '-mid-2' },
  { phase: 'end', fraction: 0.95, shot: '' },
];

/** 測った値を screenshots/visibility.json に書き足す（画面の大きさごとのテストが別々に書くので、同じ画面の行だけ置き換える）。 */
function writeVisibility(viewport: string, rows: VisibilityRow[]): void {
  mkdirSync('screenshots', { recursive: true });
  const path = 'screenshots/visibility.json';
  let all: VisibilityRow[];
  try {
    all = JSON.parse(readFileSync(path, 'utf8')) as VisibilityRow[];
  } catch {
    all = [];
  }
  all = [...all.filter((r) => r.viewport !== viewport), ...rows].sort((a, b) => a.viewport.localeCompare(b.viewport) || a.scene - b.scene);
  writeFileSync(path, JSON.stringify(all, null, 2));
}

async function checkVisibility(
  page: Page,
  viewport: { width: number; height: number },
  shot: (name: string) => string,
  options: { scenes?: readonly number[]; portrait: boolean },
): Promise<void> {
  await page.setViewportSize(viewport);
  const errors = collectErrors(page);
  await open(page);
  const tag = `${viewport.width}x${viewport.height}`;
  const rows: VisibilityRow[] = [];
  for (const i of options.scenes ?? VISIBILITY_SCENES) {
    const id = SCRIPT[i]!.id;
    const pile = PILE_SCENES[i];
    // 場面2 は始まり・途中・終わり、山が育つ場面（5・6）は積もりきる位置で測る
    const phases = id === 'akihabara-462' ? AKIHABARA_PHASES : [{ phase: null, fraction: pile?.grow ? 0.95 : 0.5, shot: '' }];
    for (const ph of phases) {
      await goToScene(page, i, ph.fraction);
      if (pile) await settlePile(page, pile.key);
      if (AKIHABARA_SHOWN[id]) {
        if (ph.phase !== 'mid') expect(await akihabaraShown(page)).toBe(ph.phase === 'start' ? 1 : AKIHABARA_SHOWN[id]);
        await page.waitForTimeout(2500);
      }
      const row = await measureScene(page, i, id, tag, ph.phase);
      rows.push(row);
      const items = row.items ? `、台数 ${row.items.clear}/${row.items.total}（建物に隠れていない ${row.items.visible}台、収まっている ${row.items.framed}台）` : '';
      const sizes = row.bikeSizes ? `、先頭の1台 ${row.bikeSizes.firstBikeLengthPx}px、印 ${row.bikeSizes.markerMinDiameterPx}px` : '';
      console.log(
        `見えている割合 ${tag} 場面${i + 1} ${id}${ph.phase ? `@${ph.phase}(${ph.fraction})` : ''}: 建物に隠れていない ${row.unoccluded}、` +
          `カードにも覆われていない ${row.clear}、画面内 ${row.onScreen}、大きさ ${row.sizeOfShortSide}${items}${sizes}、` +
          `俯角 ${row.pose.elevationDeg}°、距離 ${row.pose.distance}m${row.tightness !== null ? `、広がり ${row.tightness}` : ''}`,
      );
      await page.screenshot({ path: shot(`${i + 1}${ph.shot}`) });
    }
  }
  writeVisibility(tag, rows);
  // 本文カードが下寄せの配置（スマートフォンの縦向き）でだけ、縦長の画面用のカメラを使う
  for (const r of rows) expect(r.portrait).toBe(options.portrait);
  expect(rows.flatMap((r) => r.failures.map((f) => `場面${r.scene} ${r.id}${r.phase ? `@${r.phase}` : ''}: ${f}`))).toEqual([]);
  expect(errors).toEqual([]);
}

test('PC 幅で、場面1・2・5・6・7・8の主役（自転車・山）が建物と本文カードに隠れずに見える', async ({ page }) => {
  await checkVisibility(page, { width: 1280, height: 720 }, (n) => `screenshots/main-${n}.png`, { portrait: false });
});

test('スマートフォン幅（390×844）で、場面1・2・5・6・7・8の主役（自転車・山）が建物と本文カードに隠れずに見える', async ({ page }) => {
  await checkVisibility(page, { width: 390, height: 844 }, (n) => `screenshots/main-mobile-${n}.png`, { portrait: true });
});

test('タブレットの縦向き（768×1024、本文カードは左の列）で、場面5・6・7の山が隠れずに見え、縦長用のカメラを使わない', async ({ page }) => {
  await checkVisibility(page, { width: 768, height: 1024 }, (n) => `screenshots/main-tablet-${n}.png`, { scenes: [4, 5, 6], portrait: false });
});

/**
 * 場面の間の移動の経路（スクロールが止まったときの語りのカメラ）を細かく刻み、カメラが建物の中に入らないことを確かめる。
 * 建物の中かどうかは、変換済みの建物（public/data/buildings/）で、カメラから真上への半直線が横切る面の数で判定する。
 */
async function expectPathOutsideBuildings(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await open(page);
  const samples = await page.evaluate((perStage) => {
    const api = window.__MAIN__!;
    const n = api.stageIds().length;
    const out: { position: number; camera: { x: number; y: number; z: number } }[] = [];
    for (let k = 0; k <= perStage * (n - 1); k++) out.push({ position: k / perStage, camera: api.poseAt(k / perStage).camera });
    return out;
  }, 400);
  const solids = new BuildingSolids();
  const inside = samples.filter((s) => solids.inside(s.camera.x, s.camera.y, s.camera.z)).map((s) => s.position.toFixed(4));
  expect(inside, `${viewport.width}×${viewport.height}: 建物の中を通る位置（場面の番号 − 1 + 進み具合）`).toEqual([]);
}

test('場面の間を移る途中も、カメラが建物の中を通らない（PC 幅・スマートフォン幅）', async ({ page }) => {
  const errors = collectErrors(page);
  await expectPathOutsideBuildings(page, { width: 1280, height: 720 });
  await expectPathOutsideBuildings(page, { width: 390, height: 844 });
  expect(errors).toEqual([]);
});

/**
 * 場面 from のカメラが止まっている位置から、場面 to へ一気にスクロールし、カメラが追いつくまでの毎フレームのカメラの位置が
 * 建物の外にあることを確かめる。1 フレームで進める時間を 1/30 秒に抑え（描画の遅い環境でも動きを細かく刻む）、記録する。
 */
async function expectFastScrollOutsideBuildings(page: Page, solids: BuildingSolids, from: number, to: number): Promise<number> {
  await goToScene(page, from);
  await page.evaluate(() => {
    window.__MAIN__!.setMaxFrameDt(1 / 30);
    window.__MAIN__!.traceCamera(true);
  });
  await page.evaluate((to) => {
    const api = window.__MAIN__!;
    window.scrollTo({ top: api.scrollYFor(to, (api.holds()[to] ?? 0.4) * 0.5), behavior: 'instant' });
  }, to);
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.status().cameraIdleFrames), { timeout: SETTLE_TIMEOUT_MS, intervals: [1000] }).toBeGreaterThanOrEqual(3);
  const trace = await page.evaluate(() => {
    const t = window.__MAIN__!.traceCamera(false);
    window.__MAIN__!.setMaxFrameDt(1);
    return t;
  });
  expect(trace.length, `場面${from + 1}→${to + 1}: 記録したフレームの数`).toBeGreaterThan(20);
  const inside = trace.flatMap((c, k) => (solids.inside(c.x, c.y, c.z) ? [`${k}: (${c.x.toFixed(0)}, ${c.y.toFixed(0)}, ${c.z.toFixed(0)})`] : []));
  expect(inside, `場面${from + 1}→${to + 1} を一気にスクロールしたとき、建物の中にあったフレーム`).toEqual([]);
  return trace.length;
}

test('一気にスクロールしても、追いかけるカメラが建物の中を通らない（場面1→2、6→7、7→8。PC 幅）', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const solids = new BuildingSolids();
  for (const [from, to] of [
    [0, 1],
    [5, 6],
    [6, 7],
  ] as const) {
    const frames = await expectFastScrollOutsideBuildings(page, solids, from, to);
    console.log(`一気にスクロール 場面${from + 1}→${to + 1}: ${frames} フレーム、建物の中 0`);
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

// ---------------------------------------------------------------------------
// 変換済みの建物: 場面ごとの読み込み量（種類別）
// ---------------------------------------------------------------------------

type LoadKind = 'buildingsBaked' | 'buildingsLive' | 'ortho' | 'elevation' | 'other';

function loadKind(url: string): LoadKind {
  if (url.includes('/data/buildings/')) return 'buildingsBaked';
  if (/assets\.cms\.plateau\.reearth\.io/.test(url)) return 'buildingsLive';
  if (/plateauview\.mlit\.go\.jp\/tiles\//.test(url)) return 'ortho';
  if (/cyberjapandata\.gsi\.go\.jp/.test(url)) return 'elevation';
  return 'other';
}

/** 場面 1〜8 を順に巡り、場面ごとの読み込み量（種類別）と出そろうまでの時間を返す。 */
async function measureScenes(page: Page, query: string): Promise<Record<string, unknown>[]> {
  const totals: Record<LoadKind, number> = { buildingsBaked: 0, buildingsLive: 0, ortho: 0, elevation: 0, other: 0 };
  page.on('requestfinished', (req) => {
    void req
      .sizes()
      .then((s) => {
        totals[loadKind(req.url())] += s.responseBodySize + s.responseHeadersSize;
      })
      .catch(() => undefined);
  });
  const tOpen = Date.now();
  await page.goto(`/${query}`);
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });
  const rows: Record<string, unknown>[] = [];
  let before = { ...totals };
  for (let i = 0; i < SCRIPT.length; i++) {
    const t = await goToScene(page, i, SCRIPT[i]!.id === 'akihabara-462' ? 0.95 : 0.5);
    const settleMs = i === 0 ? Date.now() - tOpen : t;
    // 応答の大きさは非同期に数えるので、少し待ってから読む
    await page.waitForTimeout(500);
    const now = { ...totals };
    const delta = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v - before[k as LoadKind]])) as Record<LoadKind, number>;
    before = now;
    const city = await page.evaluate(() => window.__MAIN__!.status().city);
    rows.push({
      scene: i + 1,
      id: SCRIPT[i]!.id,
      settleMs,
      bytes: Object.values(delta).reduce((a, b) => a + b, 0),
      ...delta,
      bakedTriangles: city.baked?.triangles ?? null,
      bakedChunks: city.baked ? { detail: city.baked.detailChunks, far: city.baked.farChunks } : null,
    });
  }
  return rows;
}

test('変換済みの建物で、場面ごとの読み込み量（種類別）を測り、PLATEAU の建物のタイルを読まない', async ({ page }) => {
  const errors = collectErrors(page);
  const rows = await measureScenes(page, '');
  mkdirSync('screenshots', { recursive: true });
  writeFileSync('screenshots/main-metrics-buildings.json', JSON.stringify(rows, null, 2));
  for (const r of rows) {
    console.log(`場面${String(r.scene)} ${String(r.id)}: 計 ${((r.bytes as number) / 1e6).toFixed(1)} MB（建物 ${((r.buildingsBaked as number) / 1e6).toFixed(1)} MB）${((r.settleMs as number) / 1000).toFixed(1)} s`);
    expect(r.buildingsLive).toBe(0);
    // 1 つの場面で読む建物は 10MB 以下
    expect(r.buildingsBaked as number).toBeLessThanOrEqual(10e6);
  }
  // 建物を描く場面（1・2・5・6・7・8）では建物が表示されている
  for (const r of rows.filter((r) => SCRIPT[(r.scene as number) - 1]!.place)) expect(r.bakedTriangles as number).toBeGreaterThan(50_000);
  expect(errors).toEqual([]);
});

test('直接読む経路（?buildings=live）の場面ごとの読み込み量（比較用。PTM_COMPARE=1 のときだけ）', async ({ page }) => {
  test.skip(!process.env.PTM_COMPARE, '比較用（PTM_COMPARE=1 のときだけ実行）');
  const errors = collectErrors(page);
  const rows = await measureScenes(page, '?buildings=live');
  mkdirSync('screenshots', { recursive: true });
  writeFileSync('screenshots/main-metrics-live.json', JSON.stringify(rows, null, 2));
  for (const r of rows) console.log(`場面${String(r.scene)} ${String(r.id)}: 計 ${((r.bytes as number) / 1e6).toFixed(1)} MB（建物 ${((r.buildingsLive as number) / 1e6).toFixed(1)} MB）${((r.settleMs as number) / 1000).toFixed(1)} s`);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// 「データと方法」の節
// ---------------------------------------------------------------------------

/** 節の見出しの上端（画面の上端からの距離, px）。 */
async function methodsHeadingTop(page: Page): Promise<number> {
  return page.evaluate(() => document.getElementById('data-and-methods-heading')!.getBoundingClientRect().top);
}

/** 横にあふれていないか。文書と、節の中のすべての要素の右端・左端が画面の幅に収まる。 */
async function methodsOverflow(page: Page): Promise<{ docScrollWidth: number; innerWidth: number; offenders: string[] }> {
  return page.evaluate(() => {
    const w = window.innerWidth;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('#data-and-methods, #data-and-methods *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > w + 0.5 || r.left < -0.5)) offenders.push(`${el.tagName.toLowerCase()}「${(el.textContent ?? '').slice(0, 20)}」 ${Math.round(r.left)}〜${Math.round(r.right)}`);
    }
    return { docScrollWidth: document.documentElement.scrollWidth, innerWidth: w, offenders: offenders.slice(0, 5) };
  });
}

test('「データと方法」の節: 出典表示のリンクから移動でき、見出しとリンクが整い、描画が止まり、幅 320・390・1280px で横にあふれない', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);

  // 出典表示の「データと方法」のリンクから、節の見出しへ移動する
  await page.locator('.ptm-site-attribution').getByRole('link', { name: 'データと方法' }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#data-and-methods');
  await expect.poll(async () => Math.abs(await methodsHeadingTop(page)), { timeout: 30_000 }).toBeLessThan(120);
  expect(await methodsHeadingTop(page)).toBeGreaterThanOrEqual(0);

  // 見出しの構造: h2 が1つ（節の見出し）、その下に h3 が5つ（項目）
  const section = page.locator('#data-and-methods');
  await expect(section.locator('h2')).toHaveText(['データと方法']);
  await expect(section.locator('h3')).toHaveText([
    'この作品について',
    '放置自転車の台数：出典と数え方',
    '自転車の置き方：どこまでが事実か',
    '地図と3Dモデル：出典',
    '制作の技術',
  ]);
  await expect(section).not.toContainText('準備中');
  await expect(section).toContainText('個人が非営利で作りました');
  await expect(section).toContainText('国土交通省、国土地理院、東京都が作成・監修・保証したものではありません');

  // リンク: ページ内のリンクは移動先があり、外へのリンクは https の URL で、別のタブで開く
  const links = await section.locator('a').evaluateAll((els) =>
    els.map((a) => ({ href: a.getAttribute('href') ?? '', text: (a.textContent ?? '').trim(), target: a.getAttribute('target'), rel: a.getAttribute('rel') ?? '' })),
  );
  expect(links.length).toBeGreaterThan(15);
  for (const l of links) {
    expect(l.text, `リンクの文言が空: ${l.href}`).not.toBe('');
    if (l.href.startsWith('#')) {
      expect(await page.evaluate((id) => document.getElementById(id) !== null || id === 'top', l.href.slice(1)), `ページ内リンクの移動先がない: ${l.href}`).toBe(true);
    } else {
      expect(l.href, `https でない: ${l.href}`).toMatch(/^https:\/\/[^\s/]+\/\S*$/);
      expect(l.target).toBe('_blank');
      expect(l.rel).toContain('noopener');
    }
  }
  expect(links.some((l) => l.href === '#top' && l.text === '作品の先頭へ戻る')).toBe(true);

  // 背景は不透明で、画面の中ほどには 3D の画面（canvas）が見えない
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('data-and-methods')!).backgroundColor)).toMatch(/^rgb\(/);
  expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest('#data-and-methods') !== null)).toBe(true);

  // 節に入ると、3D の描画が止まる。先頭へ戻ると再開する
  await page.waitForTimeout(500);
  const frozen = await page.evaluate(() => window.__MAIN__!.status().renderCount);
  await page.waitForTimeout(2_000);
  expect(await page.evaluate(() => window.__MAIN__!.status().renderCount)).toBe(frozen);

  // 節を読んでいる間は、「地図を動かす」ボタンと読み込みの表示が節の上に重ならない
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.story-free-toggle')!).display)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.classList.contains('ptm-in-methods'))).toBe(true);
  // 節を読んでいる間は、画面の下端の出典表示が本文に重ならない
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ptm-site-attribution')!).visibility)).toBe('hidden');
  // 本文の列は画面の中央にある（前書きも「先頭へ戻る」も、列の左端が揃う）
  const lefts = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.methods__lead, .methods__toc, .methods__item, .methods__back')].map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);

  // 幅 1280px（PC）・390px・320px で横にあふれない。スクリーンショット
  mkdirSync('screenshots', { recursive: true });
  for (const [width, height, shot] of [
    [1280, 720, 'methods-desktop'],
    [390, 844, 'methods-mobile'],
    [320, 640, 'methods-320'],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.getElementById('data-and-methods')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(300);
    const o = await methodsOverflow(page);
    expect(o.docScrollWidth, `幅 ${width}px で文書が横にあふれる`).toBeLessThanOrEqual(o.innerWidth);
    expect(o.offenders, `幅 ${width}px で節からはみ出す要素`).toEqual([]);
    await section.screenshot({ path: `screenshots/${shot}.png` });
  }

  // 先頭へ戻るリンクで先頭へ戻り、描画が再開する
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => document.getElementById('data-and-methods')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await section.getByRole('link', { name: '作品の先頭へ戻る' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 30_000 }).toBeLessThan(5);
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.status().renderCount), { timeout: 60_000 }).toBeGreaterThan(frozen);

  expect(errors).toEqual([]);
});
