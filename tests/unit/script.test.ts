import { describe, expect, it } from 'vitest';
import { FACTS } from '../../src/story/content/facts';
import { formatJaCount } from '../../src/story/content/format';
import { SCRIPT } from '../../src/story/content/script';
import { growthFor } from '../../src/app/placeholders';

describe('formatJaCount', () => {
  it('1万以上は「万」、未満は3桁区切り', () => {
    expect(formatJaCount(1)).toBe('1');
    expect(formatJaCount(6_358)).toBe('6,358');
    expect(formatJaCount(13_394)).toBe('1万3,394');
    expect(formatJaCount(15_000)).toBe('1万5,000');
    expect(formatJaCount(120_509)).toBe('12万509');
    expect(formatJaCount(2_030_000)).toBe('203万');
    expect(formatJaCount(5_798_477)).toBe('579万8,477');
  });
});

describe('台本', () => {
  const text = (id: string): string => {
    const s = SCRIPT.find((x) => x.id === id);
    if (!s) throw new Error(id);
    return [s.text.heading, ...s.text.paragraphs].join('\n');
  };

  it('8場面で、id が重ならない', () => {
    expect(SCRIPT).toHaveLength(8);
    expect(new Set(SCRIPT.map((s) => s.id)).size).toBe(8);
  });

  it('本文は数値の定数から組み立てられている', () => {
    expect(text('akihabara-462')).toContain('秋葉原駅の周りには462台の自転車が放置されていた');
    expect(text('akihabara-462')).toContain('その47.8％が');
    expect(text('tokyo-13394')).toContain('合わせて1万3,394台だった');
    expect(text('tokyo-13394')).toContain('駅の周りにあった自転車54万5,983台のうち、2.5％にあたる');
    expect(text('parking-vacancy')).toContain('放置自転車があった530駅のうち425駅では');
    expect(text('parking-vacancy')).toContain('都内の駅周辺の駐輪場は2,943か所、収容能力は89万7,461台');
    expect(text('removed-fy2024')).toContain('撤去1台あたり約2万8,000円');
    expect(text('removed-15years')).toContain('15年で579万8,477台');
    expect(text('removed-15years')).toContain('新宿の都庁前、新宿中央公園に1つの山として積むと、高さはおよそ99メートル、裾の直径は約280メートルになる。');
    expect(text('removed-15years')).toContain('隣に立つ都庁第一本庁舎の高さは243メートル。');
    expect(text('removed-15years')).toContain('体積は約203万立方メートル。東京ドーム約1.6杯分');
    expect(text('after-removal')).toContain('返還されたのは64.4％だった');
    expect(text('since-1990')).toContain('1990年の24万2,760台');
    expect(text('since-1990')).toContain('1万5,000台以下にする目標');
  });

  it('再び使われた自転車の内訳は合計と一致する', () => {
    expect(FACTS.reusedOverseas.value + FACTS.reusedDomestic.value + FACTS.reusedUnknown.value).toBe(FACTS.reusedFY2024.value);
  });

  it('小数の大きな数値は桁数を持つ', () => {
    const s = SCRIPT.find((x) => x.id === 'after-removal');
    expect(s?.text.stat).toMatchObject({ value: 64.4, unit: '％', fractionDigits: 1 });
  });

  it('自由操作は最後の場面だけ', () => {
    expect(SCRIPT.map((s) => s.freeOrbit === true)).toEqual([false, false, false, false, false, false, false, true]);
  });
});

describe('growthFor', () => {
  it('0 から増え、止まっている区間の半分で増えきる', () => {
    expect(growthFor(0, 0.4)).toBe(0);
    expect(growthFor(0.1, 0.4)).toBeGreaterThan(0);
    expect(growthFor(0.2, 0.4)).toBe(1);
    expect(growthFor(1, 0.4)).toBe(1);
  });
});
