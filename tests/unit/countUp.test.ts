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
