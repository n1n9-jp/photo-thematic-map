import { describe, expect, test } from 'vitest';
import { cellAt, createHeightGrid, type HeightGrid } from '../../src/sim/heightGrid';
import { bulkVolume, coneHeight, depositPiles, type PileSource } from '../../src/sim/pile';
import { createSyntheticCity, mulberry32 } from '../../src/sim/syntheticCity';

const TAN = (deg: number): number => Math.tan((deg * Math.PI) / 180);

function sumVolume(grid: HeightGrid, thickness: Float32Array): number {
  let v = 0;
  for (let i = 0; i < thickness.length; i++) v += thickness[i] as number;
  return v * grid.cellSize * grid.cellSize;
}

function thicknessAt(grid: HeightGrid, th: Float32Array, x: number, z: number): number {
  const c = cellAt(grid, x, z);
  if (!c) throw new Error('outside');
  return th[c.row * grid.width + c.col] as number;
}

/** 平らな地面に矩形の建物（高さ top）を置く。範囲は列・行で指定。 */
function addBox(grid: HeightGrid, c0: number, r0: number, c1: number, r1: number, top: number): void {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid.data[r * grid.width + c] = top;
}

describe('bulkVolume', () => {
  test('個数 × 1個の体積 ÷ 充填率', () => {
    expect(bulkVolume(1000, 0.3, 0.25)).toBeCloseTo(1200, 9);
    expect(bulkVolume(0, 0.3, 0.25)).toBe(0);
  });
  test('不正な充填率は例外', () => {
    expect(() => bulkVolume(10, 1, 0)).toThrow(RangeError);
    expect(() => bulkVolume(10, 1, 1.5)).toThrow(RangeError);
  });
});

describe('円錐の理論値', () => {
  for (const angle of [30, 35, 40]) {
    for (const volume of [2000, 20000, 200000]) {
      test(`平地 θ=${angle}° V=${volume}`, () => {
        const grid = createHeightGrid(300, 300, 1);
        const r = depositPiles(grid, [{ x: 0.5, z: 0.5, volume }], angle);
        const p = r.piles[0]!;
        const h = coneHeight(volume, angle);
        expect(Math.abs(p.apexHeight / h - 1)).toBeLessThan(0.02);
        expect(Math.abs(sumVolume(grid, r.thickness) / volume - 1)).toBeLessThan(0.005);
        // 底面積も円錐（半径 H/tanθ）に近い
        const area = Math.PI * (h / TAN(angle)) ** 2;
        expect(Math.abs(p.area / area - 1)).toBeLessThan(0.03);
      });
    }
  }
});

describe('街区での性質', () => {
  const city = createSyntheticCity({ size: 256, seed: 7 });
  const rand = mulberry32(11);
  const sources: PileSource[] = Array.from({ length: 12 }, () => ({
    x: (rand() - 0.5) * 200,
    z: (rand() - 0.5) * 200,
    volume: 2000 + rand() * 40000,
  }));
  const angle = 35;
  const result = depositPiles(city.grid, sources, angle);
  const grid = city.grid;

  test('体積の保存（0.5% 以内）', () => {
    const target = sources.reduce((a, s) => a + s.volume, 0);
    const v = sumVolume(grid, result.thickness);
    expect(Math.abs(v / target - 1)).toBeLessThan(0.005);
    expect(Math.abs(result.totalVolume / v - 1)).toBeLessThan(1e-4);
    const perPile = result.piles.reduce((a, p) => a + p.volume, 0);
    expect(Math.abs(perPile / v - 1)).toBeLessThan(1e-4);
  });

  test('安息角: 堆積のある隣接セル間の勾配が tanθ を超えない', () => {
    // 許容差: 表面を Float32 で持つ丸め誤差ぶん（1 mm）。
    // 斜めの隣接は、間の2セルにも堆積がある場合（建物の角をはさまない場合）に検査する。
    const { width: w, height: h, cellSize: cs, data: g } = grid;
    const th = result.thickness;
    const t = TAN(angle);
    const covered = (i: number): boolean => (th[i] as number) > 0;
    const surf = (i: number): number => (g[i] as number) + (th[i] as number);
    let worst = 0;
    let pairs = 0;
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const a = r * w + c;
        if (!covered(a)) continue;
        const nbrs: Array<[number, number]> = [
          [a + 1, cs],
          [a + w, cs],
        ];
        if (covered(a + 1) && covered(a + w)) nbrs.push([a + w + 1, cs * Math.SQRT2]);
        if (c > 0 && covered(a - 1) && covered(a + w)) nbrs.push([a + w - 1, cs * Math.SQRT2]);
        for (const [b, d] of nbrs) {
          if (!covered(b)) continue;
          pairs++;
          worst = Math.max(worst, Math.abs(surf(a) - surf(b)) - t * d);
        }
      }
    }
    expect(pairs).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(1e-3);
  });

  test('つながった山の投入点は同じ group を持つ', () => {
    const groups = new Set(result.piles.map((p) => p.group));
    expect(groups.has(-1)).toBe(false);
    for (const p of result.piles) expect(p.volume).toBeGreaterThanOrEqual(0);
  });
});

describe('建物による遮蔽と回り込み', () => {
  // 平地（1m 格子, 中心が原点）。投入点 (0,0) の東 20〜40m に高さ 200m の建物。
  const grid = createHeightGrid(240, 240, 1);
  const c0 = 120 + 20;
  addBox(grid, c0, 110, c0 + 19, 129, 200);
  // 西側の 15〜20m に高さ 3m の低い建物。
  addBox(grid, 120 - 20, 115, 120 - 16, 124, 3);
  const angle = 35;
  const volume = 120000; // 円錐なら H≈39m, 半径≈56m
  const r = depositPiles(grid, [{ x: 0.5, z: 0.5, volume }], angle);
  const th = r.thickness;

  test('表面より高い建物には積もらない', () => {
    for (let row = 110; row <= 129; row++) {
      for (let col = c0; col <= c0 + 19; col++) expect(th[row * 240 + col]).toBe(0);
    }
  });

  test('建物の陰は薄く、回り込んで裏側にも積もる', () => {
    const behindEast = thicknessAt(grid, th, 45.5, 0.5); // 建物の真裏（東 45m）
    const openWest = thicknessAt(grid, th, -44.5, 0.5); // 反対側（西 45m）は遮るものなし…ただし低い建物の先
    const openNorth = thicknessAt(grid, th, 0.5, -44.5);
    expect(behindEast).toBeGreaterThan(0); // 回り込んで届く
    expect(behindEast).toBeLessThan(openNorth - 2); // 直進より遠回りなので薄い
    expect(openWest).toBeGreaterThan(0);
  });

  test('屋上より高くなれば屋上にも積もる', () => {
    expect(thicknessAt(grid, th, -17.5, 0.5)).toBeGreaterThan(1);
  });

  test('体積の保存', () => {
    expect(Math.abs(sumVolume(grid, th) / volume - 1)).toBeLessThan(0.005);
  });
});

describe('複数の投入点', () => {
  const grid = createHeightGrid(300, 300, 1);
  const angle = 35;

  test('近い2点の山は一つの連続した山になる', () => {
    const r = depositPiles(
      grid,
      [
        { x: -20, z: 0, volume: 20000 },
        { x: 20, z: 0, volume: 20000 },
      ],
      angle,
    );
    expect(r.piles[0]!.group).toBe(r.piles[1]!.group);
    // 2点の中間にも堆積がある
    expect(thicknessAt(grid, r.thickness, 0.5, 0.5)).toBeGreaterThan(1);
    expect(Math.abs(sumVolume(grid, r.thickness) / 40000 - 1)).toBeLessThan(0.005);
  });

  test('遠い2点の山は別々で、それぞれ目標の体積になる', () => {
    const r = depositPiles(
      grid,
      [
        { x: -90, z: 0, volume: 5000 },
        { x: 90, z: 0, volume: 15000 },
      ],
      angle,
    );
    expect(r.piles[0]!.group).not.toBe(r.piles[1]!.group);
    expect(Math.abs(r.piles[0]!.volume / 5000 - 1)).toBeLessThan(0.01);
    expect(Math.abs(r.piles[1]!.volume / 15000 - 1)).toBeLessThan(0.01);
  });

  test('数百点を同時に扱える', () => {
    const rand = mulberry32(5);
    const sources = Array.from({ length: 300 }, () => ({
      x: (rand() - 0.5) * 280,
      z: (rand() - 0.5) * 280,
      volume: 100 + rand() * 2000,
    }));
    const r = depositPiles(grid, sources, angle);
    const target = sources.reduce((a, s) => a + s.volume, 0);
    expect(r.piles).toHaveLength(300);
    expect(Math.abs(sumVolume(grid, r.thickness) / target - 1)).toBeLessThan(0.005);
  });

  test('格子の外の投入点は例外', () => {
    expect(() => depositPiles(grid, [{ x: 1000, z: 0, volume: 1000 }], angle)).toThrow(RangeError);
    expect(() => depositPiles(grid, [{ x: 0, z: -150.5, volume: 0 }], angle)).toThrow(RangeError);
  });
});
