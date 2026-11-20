/**
 * 開発・確認用の合成街区: 格子状の道路と、高さの違う箱型の建物。
 */
import { createHeightGrid, type BoxBuilding, type HeightGrid } from './heightGrid';

export type { BoxBuilding };

export interface SyntheticCityOptions {
  /** 格子の一辺のセル数（既定 320）。 */
  size?: number;
  /** セルの一辺(m)（既定 1）。 */
  cellSize?: number;
  /** 街区の周期(m)（道路の中心線の間隔。既定 48）。 */
  blockPitch?: number;
  /** 道路の幅(m)（既定 14）。 */
  roadWidth?: number;
  /** 建物の高さの範囲(m)（既定 4〜60）。 */
  minHeight?: number;
  maxHeight?: number;
  /** 乱数の種（既定 1）。 */
  seed?: number;
}

export interface SyntheticCity {
  grid: HeightGrid;
  buildings: BoxBuilding[];
}

/** 再現性のある簡単な擬似乱数（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 原点を中心とする合成街区を作る。原点（0,0）は道路の交差点になる。 */
export function createSyntheticCity(options: SyntheticCityOptions = {}): SyntheticCity {
  const size = options.size ?? 320;
  const cs = options.cellSize ?? 1;
  const pitch = options.blockPitch ?? 48;
  const road = options.roadWidth ?? 14;
  const minH = options.minHeight ?? 4;
  const maxH = options.maxHeight ?? 60;
  const rand = mulberry32(options.seed ?? 1);
  const grid = createHeightGrid(size, size, cs);
  const half = (size * cs) / 2;

  const buildings: BoxBuilding[] = [];
  const gap = 2; // 建物どうしの隙間(m)
  const n = Math.ceil(half / pitch) + 1;
  for (let bj = -n; bj < n; bj++) {
    for (let bi = -n; bi < n; bi++) {
      // 街区（道路に囲まれた範囲）。道路の中心線は pitch の整数倍。
      const bx0 = bi * pitch + road / 2;
      const bx1 = (bi + 1) * pitch - road / 2;
      const bz0 = bj * pitch + road / 2;
      const bz1 = (bj + 1) * pitch - road / 2;
      // 街区を 2×2 の敷地に分け、ときどき空き地にする。
      const mx = (bx0 + bx1) / 2;
      const mz = (bz0 + bz1) / 2;
      const lots: Array<[number, number, number, number]> = [
        [bx0, bz0, mx - gap / 2, mz - gap / 2],
        [mx + gap / 2, bz0, bx1, mz - gap / 2],
        [bx0, mz + gap / 2, mx - gap / 2, bz1],
        [mx + gap / 2, mz + gap / 2, bx1, bz1],
      ];
      for (const [x0, z0, x1, z1] of lots) {
        const r = rand();
        if (r < 0.08) continue; // 空き地
        const top = minH + (maxH - minH) * Math.pow(rand(), 1.6);
        if (x1 < -half || x0 > half || z1 < -half || z0 > half) continue;
        buildings.push({ x0, z0, x1, z1, top: Math.round(top * 10) / 10 });
      }
    }
  }

  for (const b of buildings) {
    const c0 = Math.max(0, Math.ceil((b.x0 - grid.originX) / cs - 0.5));
    const c1 = Math.min(size - 1, Math.floor((b.x1 - grid.originX) / cs - 0.5));
    const r0 = Math.max(0, Math.ceil((b.z0 - grid.originZ) / cs - 0.5));
    const r1 = Math.min(size - 1, Math.floor((b.z1 - grid.originZ) / cs - 0.5));
    for (let r = r0; r <= r1; r++) grid.data.fill(b.top, r * size + c0, r * size + c1 + 1);
  }
  return { grid, buildings };
}
