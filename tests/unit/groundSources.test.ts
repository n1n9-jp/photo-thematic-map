import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, SMALL_DEVICE_BUDGET } from '../../src/scene/plateau/budget';
import { defaultAttributionLines, siteAttributionLines } from '../../src/scene/plateau/attribution';

describe('地面の出典（航空写真を使わない）', () => {
  it('出典表示は建物の PLATEAU と国土地理院（標高タイル）だけで、写真を挙げない', () => {
    const text = siteAttributionLines('#m')[0]!.map((s) => (typeof s === 'string' ? s : s.text)).join('');
    expect(text).toBe('出典：国土交通省 PLATEAU・国土地理院・国土数値情報・東京都のデータを加工して作成');
    const lines = defaultAttributionLines().join('\n');
    expect(lines).toContain('標高：国土地理院 標高タイル');
    expect(lines).not.toMatch(/写真|Ortho/);
  });
});

describe('地面の細かさ（端末別）', () => {
  it('スマートフォンでは、パソコンより粗いタイルで済ませる', () => {
    expect(SMALL_DEVICE_BUDGET.groundDetailScale).toBeGreaterThan(DEFAULT_BUDGET.groundDetailScale);
  });
});
