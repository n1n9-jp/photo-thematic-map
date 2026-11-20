import { expect, test, type Page } from '@playwright/test';

// PLATEAU のタイルをネットワークから読み、数十万台の自転車をソフトウェア描画で描くので、十分に待つ
test.describe.configure({ timeout: 600_000 });

const SHOTS = [
  { site: 'marunouchi', view: 'wide', t: 1 },
  { site: 'marunouchi', view: 'close', t: 1 },
  { site: 'marunouchi', view: 'street', t: 1 },
  { site: 'marunouchi', view: 'wide', t: 0.4 },
  { site: 'shinjuku', view: 'wide', t: 1 },
  { site: 'shinjuku', view: 'close', t: 1 },
] as const;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

for (const shot of SHOTS) {
  const suffix = shot.t < 1 ? `-t${Math.round(shot.t * 100)}` : '';
  const file = `pile-scene-${shot.site}-${shot.view}${suffix}.png`;
  test(`山の場面: ${shot.site} ${shot.view} t=${shot.t}`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/demos/pile-scene.html?site=${shot.site}&view=${shot.view}&t=${shot.t}`);
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 480_000 });
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(page.locator('.ptm-attribution')).toContainText('出典：国土交通省 Project PLATEAU');
    // 描画が落ち着くまで待つ
    await page.waitForTimeout(3000);
    const s = await page.evaluate(() => window.__PILE_SCENE__);
    expect(s).toBeDefined();
    console.info(`${file}: ${JSON.stringify(s)}`);
    if (shot.site === 'marunouchi') {
      expect(s!.placed).toBe(187_262);
      expect(s!.apexHeight).toBeGreaterThan(30);
      expect(s!.apexHeight).toBeLessThan(45);
    } else {
      expect(s!.placed).toBeGreaterThan(100_000);
      expect(s!.placed).toBeLessThan(400_000);
      expect(s!.apexHeight).toBeGreaterThan(90);
      expect(s!.apexHeight).toBeLessThan(110);
    }
    expect(s!.fill.maxBelowGround).toBeLessThan(0.01);
    if (shot.t === 1) {
      expect(s!.represented).toBe(shot.site === 'marunouchi' ? 187_262 : 5_798_477);
      expect(s!.shown).toBe(s!.placed);
    } else {
      expect(s!.represented / 187_262).toBeGreaterThan(0.3);
      expect(s!.represented / 187_262).toBeLessThan(0.5);
      expect(s!.falling).toBeGreaterThan(0);
    }
    expect(s!.bikeTriangles).toBeGreaterThan(0);
    // 静止している間の1フレームの転送は小さい（自転車の常駐バッファは送り直さない）
    expect(s!.frameUploadBytes).toBeLessThan(1_000_000);
    await page.screenshot({ path: `screenshots/${file}` });
    expect(errors).toEqual([]);
  });
}
