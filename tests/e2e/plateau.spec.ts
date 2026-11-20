import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// PLATEAU のタイルをネットワークから読むので、ソフトウェア描画でも間に合うよう長めに待つ
test.setTimeout(180_000);

const VIEWS = [
  { name: 'tokyo', query: '' },
  { name: 'shibuya', query: '?lat=35.65803&lon=139.70165' },
  // 秋葉原駅を高さ 200m から見下ろす。建物はテクスチャなしだけ（detail=0）で、屋上の設備が見える
  { name: 'akihabara', query: '?lat=35.69836&lon=139.77313&view=-140,200,140&detail=0' },
] as const;

/** 描画した画面のうち「ほぼ黒」（RGB がすべて 24 未満）の画素の割合。 */
async function nearBlackRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stage = (window as unknown as { __PTM_STAGE__: { render(): void; renderer: { domElement: HTMLCanvasElement } } })
      .__PTM_STAGE__;
    // 描画した直後（同じタスクの中）なら描画バッファを読める
    stage.render();
    const src = stage.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D コンテキストを作れません');
    ctx.drawImage(src, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? 0) < 24 && (data[i + 1] ?? 0) < 24 && (data[i + 2] ?? 0) < 24) black++;
    }
    return black / (data.length / 4);
  });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

for (const view of VIEWS) {
  test(`PLATEAU の街並みが表示される（${view.name}）`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/demos/plateau.html${view.query}`);
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 150_000 });

    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(page.locator('.ptm-attribution')).toContainText('出典：国土交通省 Project PLATEAU');

    await page.waitForTimeout(500);
    await page.screenshot({ path: `screenshots/plateau-${view.name}.png` });

    // 金属度の高いマテリアル（屋上の設備など）が黒く塗りつぶされていない
    const ratio = await nearBlackRatio(page);
    console.log(`${view.name}: ほぼ黒の画素 ${(ratio * 100).toFixed(2)}%`);
    expect(ratio).toBeLessThan(0.0005);

    // 破棄すると描画ループが止まり、canvas が外れる（破棄した舞台を描こうとしてエラーにならない）
    await page.evaluate(() => (window as unknown as { __PTM_DISPOSE__: () => void }).__PTM_DISPOSE__());
    await page.waitForTimeout(500);
    await expect(page.locator('canvas')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
}
