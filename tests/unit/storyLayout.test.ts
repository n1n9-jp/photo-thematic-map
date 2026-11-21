import { describe, expect, it } from 'vitest';
import { freeRegionFor, viewShiftFor } from '../../src/story/layout';

describe('freeRegionFor', () => {
  it('side: カードの列の右側が、主役を置く範囲になる', () => {
    const r = freeRegionFor({ layout: 'side', width: 1280, height: 720, visibleHeight: 720, columnRight: 424, coverTop: 0 });
    expect(r).toEqual({ left: 440, top: 0, right: 1280, bottom: 720 });
    const s = viewShiftFor(r, 1280, 720);
    expect(s.x).toBeCloseTo((860 - 640) / 1280, 6);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it('side: 列が極端に広くても、画面の幅の4割は主役の範囲に残す', () => {
    const r = freeRegionFor({ layout: 'side', width: 800, height: 600, visibleHeight: 600, columnRight: 700, coverTop: 0 });
    expect(r.left).toBeCloseTo(480, 6);
    expect(r.right).toBe(800);
  });

  it('bottom: カードの上の範囲の中央に置く', () => {
    const r = freeRegionFor({ layout: 'bottom', width: 390, height: 844, visibleHeight: 844, columnRight: 374, coverTop: 560 });
    expect(r).toEqual({ left: 0, top: 0, right: 390, bottom: 544 });
    const s = viewShiftFor(r, 390, 844);
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.y).toBeCloseTo((272 - 422) / 844, 6);
  });

  it('bottom: カードが高すぎても、見えている高さの4分の1は主役の範囲に残す', () => {
    const r = freeRegionFor({ layout: 'bottom', width: 390, height: 844, visibleHeight: 800, columnRight: 374, coverTop: 100 });
    expect(r.bottom).toBe(200);
  });

  it('bottom: canvas が見えている高さより高い（アドレスバーが出ている）とき、見えている範囲で測る', () => {
    const r = freeRegionFor({ layout: 'bottom', width: 390, height: 844, visibleHeight: 760, columnRight: 374, coverTop: 900 });
    expect(r.bottom).toBe(760);
  });
});
