import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, SMALL_DEVICE_BUDGET } from '../../src/scene/plateau/budget';
import { defaultAttributionLines, siteAttributionLines } from '../../src/scene/plateau/attribution';
import { orthoSourceFromUrl, orthoTileUrl } from '../../src/scene/plateau/orthoSource';

describe('航空写真の出典の切り替え（?ortho=gsi）', () => {
  it('既定は PLATEAU-Ortho、?ortho=gsi で国土地理院の写真', () => {
    expect(orthoSourceFromUrl('')).toBe('plateau');
    expect(orthoSourceFromUrl('?ortho=other')).toBe('plateau');
    expect(orthoSourceFromUrl('?buildings=live&ortho=gsi')).toBe('gsi');
  });

  it('タイルの URL', () => {
    expect(orthoTileUrl('plateau', 17, 116423, 51603)).toBe('https://tile.plateauview.mlit.go.jp/tiles/plateau-ortho-2024/17/116423/51603.png');
    expect(orthoTileUrl('gsi', 17, 116423, 51603)).toBe('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/17/116423/51603.jpg');
  });

  it('国土地理院の写真に切り替えたときは、出典表示に写真を明記する', () => {
    const text = (lines: ReturnType<typeof siteAttributionLines>): string =>
      lines[0]!.map((s) => (typeof s === 'string' ? s : s.text)).join('');
    expect(text(siteAttributionLines('#m', 'plateau'))).toBe('出典：国土交通省 PLATEAU・国土地理院・国土数値情報・東京都のデータを加工して作成');
    expect(text(siteAttributionLines('#m', 'gsi'))).toContain('国土地理院（全国最新写真（シームレス）・標高タイル）');
    expect(defaultAttributionLines('plateau').join('\n')).not.toContain('全国最新写真');
    expect(defaultAttributionLines('gsi').join('\n')).toContain('航空写真：国土地理院 全国最新写真（シームレス）');
  });
});

describe('航空写真の細かさ（端末別）', () => {
  it('スマートフォンでは、パソコンより粗いタイルで済ませる', () => {
    expect(SMALL_DEVICE_BUDGET.groundTexelScale).toBeGreaterThan(DEFAULT_BUDGET.groundTexelScale);
  });
});

describe('alphaGrid（画像の不透明な区画）', () => {
  it('8×8 の区画ごとに不透明な画素があるかを返す', async () => {
    const { alphaGrid } = await import('../../src/scene/plateau/ground');
    const w = 16;
    const px = new Uint8ClampedArray(w * w * 4);
    // (x=15, y=0) は北東の端の区画、(x=2, y=9) は左から2列目・上から5行目の区画
    px[(0 * w + 15) * 4 + 3] = 255;
    px[(9 * w + 2) * 4 + 3] = 255;
    const g = alphaGrid(px, w, w, 8);
    expect([...g].reduce((a, b) => a + b, 0)).toBe(2);
    expect(g[0 * 8 + 7]).toBe(1);
    expect(g[4 * 8 + 1]).toBe(1);
  });
});
