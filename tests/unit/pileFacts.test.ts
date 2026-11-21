/**
 * 本文の山の数値（facts.ts の PILES）が、本編と同じ計算を街の高さ格子で行った結果と一致する。
 */
import { describe, expect, test } from 'vitest';
import { PILE_SITES } from '../../src/app/modules/pileSites';
import { pileProgressFor } from '../../src/app/modules/pileModule';
import { PILES } from '../../src/story/content/facts';
import { computeSitePile, pileFootprint } from '../../scripts/bake/pileFacts';

describe('山の数値', () => {
  test.each([
    ['year', PILE_SITES.year, PILES.removedFY2024],
    ['fifteenYears', PILE_SITES.fifteenYears, PILES.removed15Years],
  ] as const)('%s: 頂上の高さ・覆う面積・裾の直径', (_name, site, facts) => {
    const r = computeSitePile(site);
    // 本文の地点は、計算が開けた地表に寄せた後の投入点（寄せる量はほぼ 0）
    expect(r.site.shiftedBy).toBeLessThan(1);
    expect(r.apexHeight).toBeCloseTo(facts.heightM, 1);
    const fp = pileFootprint(r);
    expect(Math.abs(fp.areaM2 - facts.areaM2)).toBeLessThan(facts.areaM2 * 0.005);
    expect(Math.abs(fp.diameterM - facts.diameterM)).toBeLessThan(1);
  }, 60_000);
});

describe('pileProgressFor', () => {
  test('カメラが止まっている区間の 8 割で積もりきる', () => {
    expect(pileProgressFor(0, 0.5)).toBe(0);
    expect(pileProgressFor(0.2, 0.5)).toBeCloseTo(0.5);
    expect(pileProgressFor(0.4, 0.5)).toBe(1);
    expect(pileProgressFor(0.9, 0.5)).toBe(1);
  });
});
