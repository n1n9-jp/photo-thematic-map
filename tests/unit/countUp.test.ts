import { describe, expect, it } from 'vitest';
import { countValue, formatCount } from '../../src/story/countUp';

describe('formatCount', () => {
  it('3桁ごとにカンマで区切る', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});

describe('countValue', () => {
  it('経過 0 で 0、1 以上で最終値', () => {
    expect(countValue(438_000, 0)).toBe(0);
    expect(countValue(438_000, 1)).toBe(438_000);
    expect(countValue(438_000, 3)).toBe(438_000);
  });

  it('経過に対して単調に増える', () => {
    let prev = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const v = countValue(7_300_000, p);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('instant なら常に最終値', () => {
    expect(countValue(1200, 0, { instant: true })).toBe(1200);
  });
});

describe('小数の数え上げ', () => {
  it('fractionDigits の桁で表示する', () => {
    expect(formatCount(64.4, 1)).toBe('64.4');
    expect(formatCount(2, 1)).toBe('2.0');
    expect(countValue(64.4, 1, { fractionDigits: 1 })).toBe(64.4);
    const mid = countValue(64.4, 0.5, { fractionDigits: 1 });
    expect(mid).toBeGreaterThan(0);
    expect(Math.round(mid * 10)).toBeCloseTo(mid * 10, 6);
  });
});
