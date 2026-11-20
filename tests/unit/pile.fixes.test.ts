import { describe, expect, test } from 'vitest';
import { createHeightGrid, type HeightGrid } from '../../src/sim/heightGrid';
import { computePileGrowth, depositPiles, type PileSource } from '../../src/sim/pile';
import { createSyntheticCity, mulberry32 } from '../../src/sim/syntheticCity';

function sumVolume(grid: HeightGrid, thickness: Float32Array): number {
  let v = 0;
  for (let i = 0; i < thickness.length; i++) v += thickness[i] as number;
  return v * grid.cellSize * grid.cellSize;
}

/** 平地（1m 格子・中心が原点）に、中庭のある建物（外形40×40m・壁厚4m・高さ10m）を投入点の東10mに置く。 */
function courtyardGrid(): HeightGrid {
  const grid = createHeightGrid(240, 240, 1);
  const w = grid.width;
  // 投入点 (0.5, 0.5) はセル (120, 120)。建物は東へ 10m（列 130〜169）、南北は中心に揃える（行 100〜139）。
  const c0 = 130;
  const r0 = 100;
  for (let r = r0; r < r0 + 40; r++) {
    for (let c = c0; c < c0 + 40; c++) {
      const wall = r < r0 + 4 || r >= r0 + 36 || c < c0 + 4 || c >= c0 + 36;
      if (wall) grid.data[r * w + c] = 10;
    }
  }
  return grid;
}

describe('blend（屋上を越える不連続の合成）', () => {
  const grid = courtyardGrid();
  for (const volume of [11750, 12500, 13250, 14250]) {
    test(`中庭のある建物 V=${volume}: totalVolume が厚さの合計と一致する`, () => {
      const r = depositPiles(grid, [{ x: 0.5, z: 0.5, volume }], 35);
      const v = sumVolume(grid, r.thickness);
      expect(Math.abs(v / volume - 1)).toBeLessThan(0.005);
      expect(Math.abs(r.totalVolume / v - 1)).toBeLessThan(1e-4);
      expect(Math.abs(r.piles[0]!.volume / v - 1)).toBeLessThan(1e-4);
    });
  }

  for (const volume of [11750, 12500, 13250, 14250]) {
    test(`中庭のある建物 V=${volume}: 成長の体積が t に比例する（各段階で 1% 以内）`, () => {
      const growth = computePileGrowth(grid, [{ x: 0.5, z: 0.5, volume }], 35, { stages: 12 });
      const final = sumVolume(grid, growth.final.thickness);
      expect(Math.abs(growth.final.totalVolume / final - 1)).toBeLessThan(1e-4);
      for (let k = 1; k <= 24; k++) {
        const t = k / 24;
        const v = sumVolume(grid, growth.thicknessAt(t));
        expect(Math.abs(v / (t * growth.final.totalVolume) - 1)).toBeLessThan(0.01);
      }
    });
  }
});

describe('多数の投入点: 独立した山は山ごとに目標の体積になる', () => {
  test('合成街区 2000×2000・セル2m・道路上の700点・体積2〜300m³（対数一様）', () => {
    const city = createSyntheticCity({ size: 2000, cellSize: 2, seed: 4 });
    const grid = city.grid;
    const rand = mulberry32(21);
    const pitch = 48;
    const half = (grid.width * grid.cellSize) / 2;
    const sources: PileSource[] = [];
    while (sources.length < 700) {
      // 道路の中心線（pitch の整数倍）から ±5m 以内に置く。
      const along = (rand() - 0.5) * (2 * half - 40);
      const line = Math.round(((rand() - 0.5) * (2 * half - 40)) / pitch) * pitch;
      const off = (rand() - 0.5) * 10;
      const ns = rand() < 0.5;
      const x = ns ? line + off : along;
      const z = ns ? along : line + off;
      const col = Math.floor((x - grid.originX) / grid.cellSize);
      const row = Math.floor((z - grid.originZ) / grid.cellSize);
      if (grid.data[row * grid.width + col] !== 0) continue;
      const volume = 2 * Math.pow(150, rand());
      sources.push({ x, z, volume });
    }
    const r = depositPiles(grid, sources, 35);
    const count = new Map<number, number>();
    for (const p of r.piles) count.set(p.group, (count.get(p.group) ?? 0) + 1);
    let independent = 0;
    let worst = 0;
    r.piles.forEach((p, i) => {
      if (p.group < 0 || count.get(p.group) !== 1) return;
      independent++;
      worst = Math.max(worst, Math.abs(p.volume / sources[i]!.volume - 1));
    });
    expect(independent).toBeGreaterThan(500);
    expect(worst).toBeLessThan(0.01);
    const v = sumVolume(grid, r.thickness);
    expect(Math.abs(r.totalVolume / v - 1)).toBeLessThan(1e-4);
  }, 60_000);
});
