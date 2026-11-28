/**
 * 本編の地面: 8場面を PC 幅とスマートフォン幅で順に巡り、各場面のスクリーンショットを `screenshots/ground/` に保存する。
 * 地面は標高タイルの起伏を持つ単色の面で、航空写真のタイル（PLATEAU-Ortho・国土地理院の seamlessphoto）を
 * 1件も要求しないことを確かめる。
 *
 * - 環境変数 `GROUND_SHOT_DIR`（既定 `screenshots/ground`）: スクリーンショットの保存先。
 */
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCRIPT } from '../../src/story/content/script';

test.setTimeout(5_400_000);

const SETTLE_TIMEOUT_MS = 1_200_000;
const SHOT_DIR = process.env.GROUND_SHOT_DIR ?? 'screenshots/ground';

/** 航空写真のタイルの URL か（PLATEAU-Ortho と国土地理院の写真）。 */
function isOrthoTile(url: string): boolean {
  return /plateauview\.mlit\.go\.jp\/tiles\/plateau-ortho|cyberjapandata\.gsi\.go\.jp\/xyz\/seamlessphoto\//.test(url);
}

async function goToScene(page: Page, i: number, holdFraction: number): Promise<void> {
  await page.evaluate(
    ([i, f]) => {
      const api = window.__MAIN__!;
      const hold = api.holds()[i] ?? 0.4;
      window.scrollTo({ top: api.scrollYFor(i, hold * f), behavior: 'instant' });
    },
    [i, holdFraction] as const,
  );
  await expect.poll(() => page.evaluate(() => window.__MAIN__!.getState().stage), { timeout: 120_000 }).toBe(i);
  await expect
    .poll(() => page.evaluate(([i, f]) => Math.abs(window.__MAIN__!.getState().progress - (window.__MAIN__!.holds()[i] ?? 0.4) * f), [i, holdFraction] as const), {
      timeout: 120_000,
    })
    .toBeLessThan(0.01);
  await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
}

const VIEWPORTS = [
  { name: 'pc', label: 'PC 幅 1280×720', width: 1280, height: 720 },
  { name: 'mobile', label: 'スマートフォン幅 390×844', width: 390, height: 844 },
] as const;

for (const vp of VIEWPORTS) {
  test(`地面（${vp.label}）: 8場面を巡っても航空写真のタイルを要求せず、各場面を撮る`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
    const orthoRequests: string[] = [];
    page.on('request', (req) => {
      if (isOrthoTile(req.url())) orthoRequests.push(req.url());
    });
    mkdirSync(SHOT_DIR, { recursive: true });

    await page.goto('/');
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });
    for (let i = 0; i < SCRIPT.length; i++) {
      await goToScene(page, i, SCRIPT[i]!.id === 'akihabara-462' ? 0.95 : 0.5);
      // 増えた分の印が光り終わる・山が積もり終わるのを待つ
      await page.waitForTimeout(SCRIPT[i]!.place ? 4000 : 1500);
      await page.waitForFunction(() => window.__MAIN__!.isSettled(), undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 250 });
      await page.screenshot({ path: `${SHOT_DIR}/${vp.name}-${i + 1}.png` });
    }
    expect(orthoRequests.slice(0, 5), `航空写真のタイルの要求 ${orthoRequests.length}件`).toEqual([]);
    expect(errors).toEqual([]);
  });
}
