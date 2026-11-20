import { describe, expect, test, vi } from 'vitest';
import { createPileMesh } from '../../src/scene/pileMesh';
import {
  cellAt,
  countMissing,
  createHeightGrid,
  fillMissingHeights,
  findOpenGround,
  isOpenGround,
  localRelief,
  type HeightGrid,
} from '../../src/sim/heightGrid';
import { computePileGrowth, depositPiles } from '../../src/sim/pile';

function sumVolume(grid: HeightGrid, thickness: Float32Array): number {
  let v = 0;
  for (let i = 0; i < thickness.length; i++) v += thickness[i] as number;
  return v * grid.cellSize * grid.cellSize;
}

function fill(grid: HeightGrid, c0: number, r0: number, c1: number, r1: number, value: number): void {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid.data[r * grid.width + c] = value;
}

describe('格子の端', () => {
  test('格子の端に達した山を報告する', () => {
    const grid = createHeightGrid(80, 80, 1);
    const r = depositPiles(grid, [{ x: 0.5, z: 0.5, volume: 100000 }], 35);
    expect(r.reachedEdge).toBe(true);
    expect(r.piles[0]!.reachedEdge).toBe(true);
  });

  test('端に達した山だけに印がつく', () => {
    const grid = createHeightGrid(300, 300, 1);
    const r = depositPiles(
      grid,
      [
        { x: -140, z: 0, volume: 5000 }, // 円錐の半径は約 19m なので西の端（-150m）に達する
        { x: 90, z: 0, volume: 2000 },
      ],
      35,
    );
    expect(r.piles[0]!.group).not.toBe(r.piles[1]!.group);
    expect(r.reachedEdge).toBe(true);
    expect(r.piles[0]!.reachedEdge).toBe(true);
    expect(r.piles[1]!.reachedEdge).toBe(false);
  });

  test('端に達しなければ false', () => {
    const grid = createHeightGrid(300, 300, 1);
    const r = depositPiles(grid, [{ x: 0.5, z: 0.5, volume: 20000 }], 35);
    expect(r.reachedEdge).toBe(false);
    expect(r.piles[0]!.reachedEdge).toBe(false);
  });
});

describe('欠損値（NaN）', () => {
  test('欠損のセルは通れず、積もらない', () => {
    const grid = createHeightGrid(240, 240, 1);
    // 投入点 (0.5, 0.5)（セル 120,120）の東 20〜40m に欠損の帯。
    fill(grid, 140, 100, 159, 139, Number.NaN);
    const volume = 120000; // 円錐なら半径約 56m
    const r = depositPiles(grid, [{ x: 0.5, z: 0.5, volume }], 35);
    for (let row = 100; row <= 139; row++) {
      for (let col = 140; col <= 159; col++) expect(r.thickness[row * 240 + col]).toBe(0);
    }
    expect(r.thickness.every((t) => Number.isFinite(t))).toBe(true);
    const v = sumVolume(grid, r.thickness);
    expect(Math.abs(v / volume - 1)).toBeLessThan(0.005);
    expect(Math.abs(r.totalVolume / v - 1)).toBeLessThan(1e-4);
    expect(Number.isFinite(r.piles[0]!.apexY)).toBe(true);
    // 欠損の帯の裏は、回り込んだぶん同じ距離の反対側より薄い。
    const at = (x: number, z: number): number => {
      const c = cellAt(grid, x, z)!;
      return r.thickness[c.row * 240 + c.col] as number;
    };
    expect(at(45.5, 0.5)).toBeLessThan(at(-44.5, 0.5) - 1);
  });

  test('欠損の斜めの隙間はすり抜けない', () => {
    const grid = createHeightGrid(120, 120, 1);
    // 投入点を欠損の壁で囲み、角で斜めに接する箇所を作る。
    for (let k = 0; k < 120; k++) grid.data[50 * 120 + k] = Number.NaN; // 行 50 の東西の壁
    grid.data[50 * 120 + 60] = 0; // 壁に 1 セルの穴
    grid.data[51 * 120 + 60] = Number.NaN; // 穴の南を塞ぐ
    const r = depositPiles(grid, [{ x: 0.5, z: 10.5, volume: 20000 }], 35);
    // 壁の北側（行 0〜49）には届かない。
    let north = 0;
    for (let i = 0; i < 50 * 120; i++) north += r.thickness[i] as number;
    expect(north).toBe(0);
  });

  test('投入点が欠損のセルにあれば例外', () => {
    const grid = createHeightGrid(100, 100, 1);
    fill(grid, 45, 45, 55, 55, Number.NaN);
    expect(() => depositPiles(grid, [{ x: 0.5, z: 0.5, volume: 100 }], 35)).toThrow(RangeError);
    expect(() => computePileGrowth(grid, [{ x: 0.5, z: 0.5, volume: 100 }], 35)).toThrow(RangeError);
  });

  test('fillMissingHeights: 近傍の有効な値（低い側）で埋め、元の格子は変えない', () => {
    const grid = createHeightGrid(40, 40, 1);
    fill(grid, 10, 10, 29, 29, 10); // 高さ 10m の建物
    grid.data[20 * 40 + 20] = Number.NaN; // 屋上の中の穴 → 10
    grid.data[10 * 40 + 15] = Number.NaN; // 建物の縁の穴 → 地表 0 の側を採る
    fill(grid, 0, 35, 39, 39, Number.NaN); // 南の端の帯 → 0
    expect(countMissing(grid)).toBe(2 + 5 * 40);
    const filled = fillMissingHeights(grid);
    expect(countMissing(filled)).toBe(0);
    expect(countMissing(grid)).toBe(2 + 5 * 40);
    expect(filled.data[20 * 40 + 20]).toBe(10);
    expect(filled.data[10 * 40 + 15]).toBe(0);
    expect(filled.data[39 * 40 + 20]).toBe(0);
    expect(filled.width).toBe(40);
    expect(filled.originX).toBe(grid.originX);
  });

  test('fillMissingHeights: 有効な値がなければ例外', () => {
    const grid = createHeightGrid(4, 4, 1);
    grid.data.fill(Number.NaN);
    expect(() => fillMissingHeights(grid)).toThrow();
  });

  test('createPileMesh: 欠損を含む格子でもコンソールエラーを出さず、頂点は有限', () => {
    const grid = createHeightGrid(120, 120, 1);
    fill(grid, 70, 50, 80, 70, Number.NaN);
    const r = depositPiles(grid, [{ x: 0.5, z: 0.5, volume: 20000 }], 35);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pile = createPileMesh(grid, r.thickness);
      const pos = pile.mesh.geometry.getAttribute('position').array;
      expect(Array.from(pos).every((v) => Number.isFinite(v))).toBe(true);
      pile.update(new Float32Array(r.thickness.length));
      pile.dispose();
      expect(err).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('投入点の警告と開けた地表の探索', () => {
  test('建物の上の投入点に elevatedSource、地表の投入点には警告なし', () => {
    const grid = createHeightGrid(200, 200, 1);
    fill(grid, 120, 90, 139, 109, 10); // 東 20〜40m に高さ 10m の建物
    const r = depositPiles(
      grid,
      [
        { x: 20.5, z: 0.5, volume: 3000 }, // 建物の西の縁のセル
        { x: -50.5, z: 0.5, volume: 3000 },
      ],
      35,
    );
    expect(r.warnings.filter((w) => w.source === 1)).toEqual([]);
    const w0 = r.warnings.filter((w) => w.source === 0 && w.kind === 'elevatedSource');
    expect(w0).toHaveLength(1);
    expect(w0[0]!.value).toBeCloseTo(10, 5);
  });

  test('しきい値は指定できる', () => {
    const grid = createHeightGrid(200, 200, 1);
    fill(grid, 98, 98, 102, 102, 2); // 高さ 2m の台
    const src = [{ x: 0.5, z: 0.5, volume: 3000 }];
    expect(depositPiles(grid, src, 35).warnings).toEqual([]);
    const w = depositPiles(grid, src, 35, { elevatedThreshold: 1.5 }).warnings;
    expect(w.map((x) => x.kind)).toEqual(['elevatedSource']);
  });

  test('細い柱の上に少量を積むと apexHeight が負になり negativeApex を出す', () => {
    const grid = createHeightGrid(100, 100, 1);
    grid.data[50 * 100 + 50] = 10; // 1×1m・高さ 10m の柱
    const r = depositPiles(grid, [{ x: 0.9, z: 0.9, volume: 50 }], 35);
    const p = r.piles[0]!;
    expect(p.apexHeight).toBeLessThan(0);
    const kinds = r.warnings.map((w) => w.kind).sort();
    expect(kinds).toEqual(['elevatedSource', 'negativeApex']);
    expect(r.warnings.find((w) => w.kind === 'negativeApex')!.value).toBe(p.apexHeight);
  });

  test('localRelief / isOpenGround', () => {
    const grid = createHeightGrid(60, 60, 1);
    fill(grid, 20, 20, 39, 39, 12);
    expect(localRelief(grid, 20, 30)).toBe(12); // 屋上の縁
    expect(localRelief(grid, 30, 30)).toBe(0); // 半径より広い屋上の中央
    expect(localRelief(grid, 5, 5)).toBe(0);
    expect(isOpenGround(grid, 20, 30)).toBe(false);
    expect(isOpenGround(grid, 19, 30)).toBe(true);
    grid.data[5 * 60 + 5] = Number.NaN;
    expect(Number.isNaN(localRelief(grid, 5, 5))).toBe(true);
    expect(isOpenGround(grid, 5, 5)).toBe(false);
  });

  test('findOpenGround: 建物の縁から最も近い開けた地表のセル', () => {
    const grid = createHeightGrid(200, 200, 1);
    fill(grid, 120, 90, 139, 109, 10); // x: 20〜40m, z: -10〜10m
    // 建物の西の縁の内側 (20.5, 0.5) → 西隣の地表 (19.5, 0.5)
    const a = findOpenGround(grid, 20.5, 0.5)!;
    expect(a).not.toBeNull();
    expect(a.x).toBeCloseTo(19.5, 9);
    expect(a.z).toBeCloseTo(0.5, 9);
    expect(a.distance).toBeCloseTo(1, 9);
    expect(isOpenGround(grid, a.col, a.row)).toBe(true);
    // 地表の点はそのセル自身
    const b = findOpenGround(grid, -30.2, 4.7)!;
    expect(b.x).toBeCloseTo(-30.5, 9);
    expect(b.z).toBeCloseTo(4.5, 9);
    // 欠損の中の点は近くの有効なセルへ
    fill(grid, 0, 0, 9, 199, Number.NaN); // 西端の 10 列が欠損
    const c = findOpenGround(grid, -97.5, 0.5)!;
    expect(c.col).toBe(10);
    expect(c.distance).toBeCloseTo(8, 9);
    // maxDistance の内になければ null
    expect(findOpenGround(grid, -97.5, 0.5, { maxDistance: 5 })).toBeNull();
    // 格子の外の点
    const d = findOpenGround(grid, 0.5, 500)!;
    expect(d.row).toBe(199);
  });
});
