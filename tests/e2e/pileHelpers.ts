/**
 * 本編の山の場面（場面5・6・7）の確認: 山が表示され、表す台数が実数に達し、場面の途中では自転車が降っている。
 * main.spec.ts から呼ぶ。描いた三角形数などを返す（screenshots/main-piles-metrics*.json に書き出す）。
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PILE_SITES } from '../../src/app/modules/pileSites';
import type { PileDebugStatus } from '../../src/app/modules/pileModule';

/** 場面の番号（0 始まり）→ 山。 */
export const PILE_SCENES: Record<number, { key: string; count: number; grow: boolean }> = {
  4: { key: PILE_SITES.year.key, count: PILE_SITES.year.count, grow: true },
  5: { key: PILE_SITES.fifteenYears.key, count: PILE_SITES.fifteenYears.count, grow: true },
  6: { key: PILE_SITES.year.key, count: PILE_SITES.year.count, grow: false },
};

export interface PileMetric {
  scene: number;
  key: string;
  viewport: string;
  profile: string;
  triangles: number;
  perLod: [number, number, number];
  dots: number;
  represented: number;
  computeMs: number | null;
  readyAtMs: number | null;
}

// 場面5・6 は山と街並み（建物 約 700 万三角形）を同時に描くので、ソフトウェア描画では出そろうまで 4 分を超え、ほかの E2E と並行すると 10 分を超えることがある
const SETTLE_TIMEOUT_MS = 1_200_000;

function status(page: Page, key: string): Promise<PileDebugStatus> {
  return page.evaluate((k) => window.__PILES__!.status(k)!, key);
}

async function scrollTo(page: Page, i: number, holdFactor: number): Promise<void> {
  await page.evaluate(
    ([i, f]) => {
      const api = window.__MAIN__!;
      const hold = api.holds()[i] ?? 0.4;
      window.scrollTo({ top: api.scrollYFor(i, hold * f), behavior: 'instant' });
    },
    [i, holdFactor] as const,
  );
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage), { timeout: 120_000 }).toBe(i);
}

/** 山が計算を終え、街並みが出そろい、落下も終わるのを待つ。 */
export async function settlePile(page: Page, key: string): Promise<void> {
  await page.waitForFunction((k) => window.__PILES__?.status(k)?.state === 'ready', key, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
  await settle(page, key);
}

/** 街並みが出そろい、落下も終わるのを待つ（ソフトウェア描画は 1 フレーム数秒で、落下は 1 フレーム最大 0.1 秒ずつしか進まない）。 */
async function settle(page: Page, key: string): Promise<void> {
  await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
  await page.waitForFunction((k) => ((st) => st.falling === 0 && !st.animating)(window.__PILES__!.status(k)!), key, { timeout: 300_000, polling: 250 });
}

/**
 * 場面 i（山の場面）を確かめる。fallingShot を渡すと、降っている途中の静止画も撮る。
 * 終わったときは、山が積もりきって、カメラが止まっている状態（呼び出し側がそのままスクリーンショットを撮る）。
 */
export async function checkPileScene(page: Page, i: number, viewport: string, fallingShot?: string): Promise<PileMetric> {
  const spec = PILE_SCENES[i]!;
  await page.waitForFunction((k) => window.__PILES__?.status(k)?.state === 'ready', spec.key, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
  if (spec.grow) {
    // 場面の途中: 山は育ちかけで、上空から自転車が降っている（'surface' は表面が上がるたびに降り直す）
    await scrollTo(page, i, 0.15);
    await settle(page, spec.key);
    await scrollTo(page, i, 0.4);
    // 降っている途中の状態があった（山は場面に入ってからしか更新しないので、記録があればこの場面で降った）。
    // ソフトウェア描画では 1 フレームが数十秒かかるので、その瞬間を待たず、途中だった時刻の記録で確かめる
    await page.waitForFunction((k) => window.__PILES__!.status(k)!.lastAnimatingAtMs !== null, spec.key, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
    const mid = await status(page, spec.key);
    expect(mid.represented).toBeGreaterThan(0);
    expect(mid.represented).toBeLessThan(spec.count);
    if (fallingShot) {
      await settle(page, spec.key);
      await page.evaluate((k) => window.__PILES__!.freezeMidair(k, true), spec.key);
      // 止めた状態を描くのを待つ
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      expect((await status(page, spec.key)).falling).toBeGreaterThan(0);
      await page.screenshot({ path: fallingShot });
      await page.evaluate((k) => window.__PILES__!.freezeMidair(k, false), spec.key);
    }
    // 本文を読み終えるころには積もりきる
    await scrollTo(page, i, 0.95);
  }
  await settle(page, spec.key);
  const s = await status(page, spec.key);
  expect(s.visible).toBe(true);
  expect(s.progress).toBe(1);
  expect(s.represented).toBe(spec.count);
  expect(s.triangles).toBeGreaterThan(0);
  return {
    scene: i + 1,
    key: spec.key,
    viewport,
    profile: s.profile,
    triangles: s.triangles,
    perLod: s.perLod,
    dots: s.dots,
    represented: s.represented,
    computeMs: s.readyAtMs !== null && s.startedAtMs !== null ? Math.round(s.readyAtMs - s.startedAtMs) : null,
    readyAtMs: s.readyAtMs !== null ? Math.round(s.readyAtMs) : null,
  };
}
