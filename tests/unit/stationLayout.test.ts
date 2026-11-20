import { describe, expect, it } from 'vitest';
import { cellAt, createHeightGrid, type HeightGrid } from '../../src/sim/heightGrid';
import { createSyntheticCity } from '../../src/sim/syntheticCity';
import { layoutStation, prepareStreetMap, type StationLayout } from '../../src/sim/stationLayout';

const city = createSyntheticCity({ size: 400, seed: 3 });
const map = prepareStreetMap(city.grid);
/** 合成街区の (24, 24) は 2m の路地。駅舎の上の駅は別に作る。 */
const STATION = { x: 0, z: 0 };

function heightAt(grid: HeightGrid, x: number, z: number): number {
  const c = cellAt(grid, x, z);
  return c ? grid.data[c.row * grid.width + c.col]! : NaN;
}

/** 長方形の4隅（長さ 1.8、幅 w）。 */
function corners(l: StationLayout, i: number, w: number): Array<[number, number]> {
  const x = l.positions[i * 3]!;
  const z = l.positions[i * 3 + 2]!;
  const yaw = l.yaws[i]!;
  const ux = Math.cos(yaw);
  const uz = -Math.sin(yaw);
  const vx = -uz;
  const vz = ux;
  const hl = l.bikeLength / 2;
  const hw = w / 2;
  return [
    [x + ux * hl + vx * hw, z + uz * hl + vz * hw],
    [x + ux * hl - vx * hw, z + uz * hl - vz * hw],
    [x - ux * hl - vx * hw, z - uz * hl - vz * hw],
    [x - ux * hl + vx * hw, z - uz * hl + vz * hw],
  ];
}

/** 凸多角形どうしの重なり（分離軸判定。接するだけは重ならないとみなす）。 */
function polygonsOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, z0] = poly[i]!;
      const [x1, z1] = poly[(i + 1) % poly.length]!;
      const nx = -(z1 - z0);
      const nz = x1 - x0;
      const pa = a.map(([x, z]) => x * nx + z * nz);
      const pb = b.map(([x, z]) => x * nx + z * nz);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
    }
  }
  return true;
}

/** 順位相関（スピアマン）。 */
function spearman(values: number[]): number {
  const n = values.length;
  const ranks = new Array<number>(n);
  values
    .map((v, i) => [v, i] as const)
    .sort((p, q) => p[0] - q[0])
    .forEach(([, i], r) => (ranks[i] = r));
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ranks[i]! - i) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const layout462 = layoutStation(map, STATION, 462, 1);

describe('prepareStreetMap', () => {
  it('道路を路上、建物の屋上を路上でないと判定する', () => {
    const g = city.grid;
    let checked = 0;
    for (let i = 0; i < g.data.length; i += 97) {
      const isGround = g.data[i] === 0;
      expect(map.street[i]).toBe(isGround ? 1 : 0);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('通りの半幅は wallDist の近傍最大値と一致する', () => {
    const g = createHeightGrid(37, 29, 1);
    for (let i = 0; i < g.data.length; i++) g.data[i] = (i * 7919) % 13 < 3 ? 10 : 0;
    const m = prepareStreetMap(g, { halfWidthWindow: 4, minStreetArea: 0 });
    for (let r = 0; r < g.height; r++) {
      for (let c = 0; c < g.width; c++) {
        let want = 0;
        for (let rr = Math.max(0, r - 4); rr <= Math.min(g.height - 1, r + 4); rr++) {
          for (let cc = Math.max(0, c - 4); cc <= Math.min(g.width - 1, c + 4); cc++) {
            want = Math.max(want, Math.min(m.wallDist[rr * g.width + cc]!, 1e4));
          }
        }
        expect(m.halfWidth[r * g.width + c]).toBeCloseTo(want, 4);
      }
    }
  });
});

describe('layoutStation', () => {
  it('台数ぶんを置く', () => {
    expect(layout462.count).toBe(462);
    expect(layout462.positions.length).toBe(462 * 3);
    expect(layout462.yaws.length).toBe(462);
    for (const v of layout462.positions) expect(Number.isFinite(v)).toBe(true);
    expect(layoutStation(map, STATION, 0, 1).count).toBe(0);
  });

  it('建物の上や欠損のセルに置かない（足元の四隅と中心が地表）', () => {
    // 欠損（NaN）の帯を含む格子
    const g = createSyntheticCity({ size: 200, seed: 5 }).grid;
    for (let r = 0; r < g.height; r++) for (let c = 120; c < 126; c++) g.data[r * g.width + c] = NaN;
    const l = layoutStation(g, { x: 20, z: 0 }, 300, 2);
    for (const [grid, lay] of [
      [city.grid, layout462],
      [g, l],
    ] as const) {
      for (let i = 0; i < lay.count; i++) {
        const y = lay.positions[i * 3 + 1]!;
        expect(y).toBe(0);
        for (const [x, z] of [...corners(lay, i, 0.42), [lay.positions[i * 3]!, lay.positions[i * 3 + 2]!] as [number, number]]) {
          expect(heightAt(grid, x, z)).toBe(0);
        }
      }
    }
  });

  it('自転車どうしが重ならない（1.8m × 0.42m の長方形）', () => {
    const l = layout462;
    for (let i = 0; i < l.count; i++) {
      const a = corners(l, i, 0.42);
      for (let j = i + 1; j < l.count; j++) {
        if (Math.hypot(l.positions[i * 3]! - l.positions[j * 3]!, l.positions[i * 3 + 2]! - l.positions[j * 3 + 2]!) > 2) continue;
        expect(polygonsOverlap(a, corners(l, j, 0.42)), `${i} と ${j}`).toBe(false);
      }
    }
  });

  it('列の中の間隔は 0.5〜0.6m を中心にする', () => {
    const l = layout462;
    const gaps: number[] = [];
    for (let i = 0; i < l.count; i++) {
      let best = Infinity;
      for (let j = 0; j < l.count; j++) {
        if (i === j || l.rows[i] !== l.rows[j]) continue;
        best = Math.min(best, Math.hypot(l.positions[i * 3]! - l.positions[j * 3]!, l.positions[i * 3 + 2]! - l.positions[j * 3 + 2]!));
      }
      gaps.push(best);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1]!;
    expect(median).toBeGreaterThanOrEqual(0.5);
    expect(median).toBeLessThanOrEqual(0.63);
  });

  it('駅から半径以内に収まる', () => {
    for (const [lay, radius, st] of [
      [layout462, 500, STATION],
      [layoutStation(map, { x: 30, z: -10 }, 400, 3, { radius: 60 }), 60, { x: 30, z: -10 }],
    ] as const) {
      for (let i = 0; i < lay.count; i++) {
        const d = Math.hypot(lay.positions[i * 3]! - st.x, lay.positions[i * 3 + 2]! - st.z);
        expect(d + lay.bikeLength / 2).toBeLessThanOrEqual(radius + 1e-6);
      }
    }
  });

  it('置いた順は駅からの距離についておおむね単調', () => {
    const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    // 駅舎の上の駅（作品の場面に近い）と、交差点の中の駅
    const cases = [
      { st: { x: 24, z: 24 }, l: layoutStation(map, { x: 24, z: 24 }, 462, 1), minRho: 0.7 },
      { st: STATION, l: layout462, minRho: 0.3 },
    ];
    for (const { st, l, minRho } of cases) {
      const d: number[] = [];
      for (let i = 0; i < l.count; i++) d.push(Math.hypot(l.positions[i * 3]! - st.x, l.positions[i * 3 + 2]! - st.z));
      expect(spearman(d)).toBeGreaterThan(minRho);
      // 十分位ごとの平均距離: 先頭の1割は最後の1割より駅に近い
      expect(mean(d.slice(0, 46))).toBeLessThan(mean(d.slice(-46)) * 0.8);
      // 経路距離の逆転は、列と塊と乱れの加算の和（20*3+10+2）を超えない
      let maxSoFar = 0;
      for (let i = 0; i < l.count; i++) {
        expect(l.pathDistances[i]!).toBeGreaterThanOrEqual(maxSoFar - 72);
        maxSoFar = Math.max(maxSoFar, l.pathDistances[i]!);
      }
    }
  });

  it('先頭の k 台は k 台で置いたときの配置と同じ', () => {
    const l40 = layoutStation(map, STATION, 40, 1);
    expect(Array.from(l40.positions)).toEqual(Array.from(layout462.positions.subarray(0, 120)));
    expect(Array.from(l40.yaws)).toEqual(Array.from(layout462.yaws.subarray(0, 40)));
  });

  it('同じ入力と種なら同じ結果、種が違えば違う結果', () => {
    const a = layoutStation(city.grid, STATION, 200, 7);
    const b = layoutStation(prepareStreetMap(city.grid), STATION, 200, 7);
    const c = layoutStation(map, STATION, 200, 8);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.yaws)).toEqual(Array.from(b.yaws));
    expect(Array.from(a.rolls)).toEqual(Array.from(b.rolls));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
  });

  it('通りの中央を空け、両側の壁際に並べる', () => {
    // 東西に延びる幅 14m の通り（z = -7〜7）を、両側の長い建物が挟む
    const g = createHeightGrid(200, 60, 1, -100, -30);
    for (let r = 0; r < g.height; r++) {
      const z = g.originZ + r + 0.5;
      if (Math.abs(z) > 7) g.data.fill(20, r * g.width, (r + 1) * g.width);
    }
    const l = layoutStation(g, { x: 0, z: -15 }, 150, 4);
    let north = 0;
    let south = 0;
    for (let i = 0; i < l.count; i++) {
      for (const [, z] of corners(l, i, 0.42)) expect(Math.abs(z)).toBeGreaterThanOrEqual(2.0);
      const z = l.positions[i * 3 + 2]!;
      if (z < 0) north++;
      else south++;
      // 壁に直交する向き（yaw が ±90° 付近）
      expect(Math.abs(Math.cos(l.yaws[i]!))).toBeLessThan(0.3);
    }
    expect(north).toBeGreaterThan(20);
    expect(south).toBeGreaterThan(20);
  });

  it('駅の位置が建物（駅舎）の上でも、周りの路上から置く', () => {
    const g = createSyntheticCity({ size: 300, seed: 3 }).grid;
    // 原点の南東の街区（x, z = 7〜41）を高さ 16m の駅舎で埋める
    for (let r = 0; r < g.height; r++) {
      const z = g.originZ + r + 0.5;
      if (z < 7 || z > 41) continue;
      for (let c = 0; c < g.width; c++) {
        const x = g.originX + c + 0.5;
        if (x >= 7 && x <= 41) g.data[r * g.width + c] = 16;
      }
    }
    const st = { x: 24, z: 24 };
    expect(heightAt(g, st.x, st.z)).toBe(16);
    const l = layoutStation(g, st, 200, 1);
    expect(heightAt(g, l.start.x, l.start.z)).toBe(0);
    const sides = new Set<string>();
    for (let i = 0; i < l.count; i++) {
      const x = l.positions[i * 3]!;
      const z = l.positions[i * 3 + 2]!;
      expect(heightAt(g, x, z)).toBe(0);
      if (x < 7) sides.add('W');
      if (x > 41) sides.add('E');
      if (z < 7) sides.add('N');
      if (z > 41) sides.add('S');
    }
    // 駅舎の四方の通りに置かれる
    expect(sides.size).toBe(4);
  });

  it('置ける場所が足りなければ例外を投げる', () => {
    expect(() => layoutStation(map, STATION, 5000, 1, { radius: 40 })).toThrow(/足りません/);
    const allRoof = createHeightGrid(50, 50, 1);
    allRoof.data.fill(NaN);
    expect(() => layoutStation(allRoof, { x: 0, z: 0 }, 1, 1)).toThrow();
    expect(() => layoutStation(map, STATION, 1.5, 1)).toThrow();
  });
});
