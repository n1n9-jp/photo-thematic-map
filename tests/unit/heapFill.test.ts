import { describe, expect, it } from 'vitest';
import { BIKE_HULL, fillHeap, surfaceDepths, type HeapFillResult } from '../../src/sim/heapFill';
import { createHeightGrid, type HeightGrid } from '../../src/sim/heightGrid';
import { computePileGrowth, depositPiles, type PileGrowth } from '../../src/sim/pile';
import { createSyntheticCity } from '../../src/sim/syntheticCity';
import { FRAME_PALETTE, createBicycleGeometry } from '../../src/scene/bicycle/geometry';
import { heapFillToInstances, heapOnSurface } from '../../src/scene/bicycle/layouts';

const UNIT = 0.35;
const ANGLE = 35;

/** 傾いた地面（原点から離れるほど下がる接平面の近似）と建物2棟の格子。 */
function slopedGround(): HeightGrid {
  const g = createHeightGrid(160, 160, 1);
  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const x = g.originX + c + 0.5;
      const z = g.originZ + r + 0.5;
      // 0.03 の傾き + ゆるい曲率（接平面から地表が下がるのに相当）
      g.data[r * g.width + c] = 0.03 * x - 0.02 * z - (x * x + z * z) / (2 * 6371) - 0.2;
    }
  }
  const box = (x0: number, z0: number, x1: number, z1: number, top: number): void => {
    for (let r = 0; r < g.height; r++) {
      for (let c = 0; c < g.width; c++) {
        const x = g.originX + c + 0.5;
        const z = g.originZ + r + 0.5;
        if (x >= x0 && x < x1 && z >= z0 && z < z1) g.data[r * g.width + c] = top;
      }
    }
  };
  box(8, -10, 20, 6, 12);
  box(-25, 4, -12, 14, 3);
  // 欠損のセル
  g.data[40 * g.width + 40] = Number.NaN;
  return g;
}

interface Case {
  ground: HeightGrid;
  thickness: Float32Array;
  growth: PileGrowth;
  count: number;
}

function makeCase(count: number): Case {
  const ground = slopedGround();
  const growth = computePileGrowth(ground, [{ x: 0, z: 0, volume: count * UNIT }], ANGLE);
  return { ground, thickness: growth.final.thickness, growth, count };
}

/** 中心がどのセルの柱に入るか。 */
function columnOf(g: HeightGrid, x: number, z: number): number {
  const c = Math.floor((x - g.originX) / g.cellSize);
  const r = Math.floor((z - g.originZ) / g.cellSize);
  return r * g.width + c;
}

describe('fillHeap: 全台を詰める', () => {
  const cs = makeCase(20000);
  const res = fillHeap({ ground: cs.ground, thickness: cs.thickness, count: cs.count, seed: 7, growth: cs.growth });

  it('台数が正確に一致し、配列の長さがそろう', () => {
    expect(res.mode).toBe('full');
    expect(res.count).toBe(20000);
    expect(res.representedCount).toBe(20000);
    expect(res.positions.length).toBe(60000);
    expect(res.quaternions.length).toBe(80000);
    expect(res.centers.length).toBe(60000);
    expect(res.depths.length).toBe(20000);
    expect(res.arrivals.length).toBe(20000);
    expect(Math.abs(res.volumeMismatch)).toBeLessThan(0.01);
    expect(res.effectiveUnitVolume).toBeCloseTo(cs.thickness.reduce((a, b) => a + b, 0) / 20000, 4);
  });

  it('同じ入力と種なら同じ結果、種を変えると変わる', () => {
    const again = fillHeap({ ground: cs.ground, thickness: cs.thickness, count: cs.count, seed: 7, growth: cs.growth });
    expect(again.positions).toEqual(res.positions);
    expect(again.quaternions).toEqual(res.quaternions);
    expect(again.depths).toEqual(res.depths);
    const other = fillHeap({ ground: cs.ground, thickness: cs.thickness, count: cs.count, seed: 8, growth: cs.growth });
    expect(other.positions).not.toEqual(res.positions);
  });

  it('四元数は単位長', () => {
    for (let i = 0; i < res.count; i += 97) {
      const q = res.quaternions.subarray(i * 4, i * 4 + 4);
      expect(Math.hypot(...q)).toBeCloseTo(1, 4);
    }
  });

  it('中心は堆積のある柱の中、地表より上で表面より下', () => {
    const g = cs.ground;
    let bad = 0;
    for (let i = 0; i < res.count; i++) {
      const x = res.centers[i * 3]!;
      const y = res.centers[i * 3 + 1]!;
      const z = res.centers[i * 3 + 2]!;
      const k = columnOf(g, x, z);
      if (!(cs.thickness[k]! > 0) || !(y > g.data[k]!) || !(y < g.data[k]! + cs.thickness[k]! + 1.0)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('最下点は地表より上（潜らない）、上端はほぼ表面の付近', () => {
    expect(res.stats.maxBelowGround).toBeLessThan(0.01);
    expect(res.stats.overTop / res.count).toBeLessThan(0.03);
    expect(res.stats.maxOverTop).toBeLessThan(0.8);
  });

  it('密度は一様（山を高さと方位で分けた区画ごとに、台数が体積に比例する）', () => {
    const g = cs.ground;
    // 区画: 方位4つ × 地表からの高さの割合（柱の下半分・上半分）
    const vol = new Float64Array(8);
    const cnt = new Float64Array(8);
    for (let k = 0; k < cs.thickness.length; k++) {
      const t = cs.thickness[k]!;
      if (!(t > 0)) continue;
      const r = (k / g.width) | 0;
      const c = k - r * g.width;
      const q = (g.originX + c + 0.5 > 0 ? 1 : 0) + (g.originZ + r + 0.5 > 0 ? 2 : 0);
      vol[q * 2] = vol[q * 2]! + t / 2;
      vol[q * 2 + 1] = vol[q * 2 + 1]! + t / 2;
    }
    for (let i = 0; i < res.count; i++) {
      const x = res.centers[i * 3]!;
      const y = res.centers[i * 3 + 1]!;
      const z = res.centers[i * 3 + 2]!;
      const k = columnOf(g, x, z);
      const q = (x > 0 ? 1 : 0) + (z > 0 ? 2 : 0);
      const upper = y - g.data[k]! > cs.thickness[k]! / 2 ? 1 : 0;
      cnt[q * 2 + upper] = cnt[q * 2 + upper]! + 1;
    }
    const totalV = vol.reduce((a, b) => a + b, 0);
    for (let b = 0; b < 8; b++) {
      const expected = (vol[b]! / totalV) * res.count;
      expect(Math.abs(cnt[b]! / expected - 1)).toBeLessThan(0.08);
    }
  });

  it('表面の近くの自転車は斜面に沿って寝ている（車体の横方向が法線に近い）', () => {
    let near = 0;
    let lying = 0;
    for (let i = 0; i < res.count; i++) {
      if (res.depths[i]! > 0.5) continue;
      near++;
      const [x, y, z, w] = res.quaternions.subarray(i * 4, i * 4 + 4) as unknown as [number, number, number, number];
      // 車体の +Z を回した向きの Y 成分
      const zy = 2 * (y * z - w * x);
      if (Math.abs(zy) > 0.5) lying++;
    }
    expect(near).toBeGreaterThan(1000);
    expect(lying / near).toBeGreaterThan(0.6);
  });

  it('深さは表面からの深さ（0 以上、内部ほど深い）', () => {
    let max = 0;
    let min = Infinity;
    for (let i = 0; i < res.count; i++) {
      min = Math.min(min, res.depths[i]!);
      max = Math.max(max, res.depths[i]!);
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeGreaterThan(3);
    const again = surfaceDepths(cs.ground, cs.thickness, res.centers);
    let diff = 0;
    for (let i = 0; i < res.count; i++) diff = Math.max(diff, Math.abs(again[i]! - res.depths[i]!));
    expect(diff).toBeLessThan(1e-3);
  });

  it('並びは成長の順で、先頭 k 台は k 台ぶんの小さな山に収まる', () => {
    let unsorted = 0;
    for (let i = 1; i < res.count; i++) if (res.arrivals[i]! < res.arrivals[i - 1]!) unsorted++;
    expect(unsorted).toBe(0);
    const g = cs.ground;
    for (const f of [0.1, 0.3, 0.6]) {
      const k = Math.round(f * res.count);
      const partial = cs.growth.thicknessAt(f);
      let inside = 0;
      for (let i = 0; i < k; i++) {
        const x = res.centers[i * 3]!;
        const y = res.centers[i * 3 + 1]!;
        const z = res.centers[i * 3 + 2]!;
        const c = columnOf(g, x, z);
        if (partial[c]! > 0 && y <= g.data[c]! + partial[c]! + 0.3) inside++;
      }
      expect(inside / k).toBeGreaterThan(0.97);
      // 進捗 f の山に覆われる台数は、ほぼ f × 全台
      expect(Math.abs(res.arrivals[k]! - f)).toBeLessThan(0.03);
    }
  });

  it('成長を渡さなくても、表面から深い順（下・内側から）に並ぶ', () => {
    const plain = fillHeap({ ground: cs.ground, thickness: cs.thickness, count: cs.count, seed: 7 });
    expect(plain.count).toBe(cs.count);
    const g = cs.ground;
    const k = Math.round(0.3 * plain.count);
    const partial = cs.growth.thicknessAt(0.3);
    let inside = 0;
    for (let i = 0; i < k; i++) {
      const c = columnOf(g, plain.centers[i * 3]!, plain.centers[i * 3 + 2]!);
      if (partial[c]! > 0 && plain.centers[i * 3 + 1]! <= g.data[c]! + partial[c]! + 0.3) inside++;
    }
    expect(inside / k).toBeGreaterThan(0.9);
  });
});

describe('fillHeap: 表層だけを置く', () => {
  const cs = makeCase(60000);
  const full = fillHeap({ ground: cs.ground, thickness: cs.thickness, count: cs.count, seed: 3 });
  const shell = fillHeap({ ground: cs.ground, thickness: cs.thickness, count: cs.count, seed: 3, mode: 'surface', surfaceDepth: 1.5 });

  it('表す台数は全台、配置した台数は表層の体積ぶん', () => {
    expect(shell.mode).toBe('surface');
    expect(shell.representedCount).toBe(60000);
    expect(shell.count).toBeLessThan(60000);
    // 全台を詰めたときに表層（深さ 1.5m 以内）に入る台数とほぼ同じ
    let inShell = 0;
    for (let i = 0; i < full.count; i++) if (full.depths[i]! <= 1.5) inShell++;
    expect(Math.abs(shell.count / inShell - 1)).toBeLessThan(0.1);
  });

  it('配置した自転車は表層にあり、地表に潜らない', () => {
    let deepest = 0;
    for (let i = 0; i < shell.count; i++) deepest = Math.max(deepest, shell.depths[i]!);
    // 表層の範囲は柱ごとの鉛直の深さで決めるので、法線方向の深さはわずかに超えうる
    expect(deepest).toBeLessThan(1.5 + 0.4);
    expect(shell.stats.maxBelowGround).toBeLessThan(0.01);
  });
});

describe('fillHeap: 合成街区', () => {
  it('建物の間を埋め、壁の外の地表に潜らない', () => {
    const city = createSyntheticCity({ size: 240, seed: 2, minHeight: 3, maxHeight: 45 });
    const count = 30000;
    const pile = depositPiles(city.grid, [{ x: 0, z: 0, volume: count * UNIT }], ANGLE);
    const res = fillHeap({ ground: city.grid, thickness: pile.thickness, count, seed: 1 });
    expect(res.count).toBe(count);
    expect(res.stats.maxBelowGround).toBeLessThan(0.01);
    expect(res.stats.overTop / count).toBeLessThan(0.05);
    // 道路（地表 0）にも屋上にも自転車がある
    let onRoad = 0;
    let onRoof = 0;
    for (let i = 0; i < count; i++) {
      const k = columnOf(city.grid, res.centers[i * 3]!, res.centers[i * 3 + 2]!);
      if (city.grid.data[k]! === 0) onRoad++;
      else onRoof++;
    }
    expect(onRoad).toBeGreaterThan(count * 0.3);
    expect(onRoof).toBeGreaterThan(0);
  });
});

describe('fillHeap: 外形の代表点', () => {
  it('代表点は近景の形状の外接箱の中にある', () => {
    const bb = createBicycleGeometry(0).boundingBox!;
    for (const [x, y, z] of BIKE_HULL) {
      expect(x).toBeGreaterThanOrEqual(bb.min.x - 0.01);
      expect(x).toBeLessThanOrEqual(bb.max.x + 0.01);
      expect(y).toBeGreaterThanOrEqual(bb.min.y - 0.01);
      expect(y).toBeLessThanOrEqual(bb.max.y + 0.01);
      expect(z).toBeGreaterThanOrEqual(bb.min.z - 0.01);
      expect(z).toBeLessThanOrEqual(bb.max.z + 0.01);
    }
  });
});

describe('fillHeap: 実測', () => {
  it('1年ぶん（187,262台）を詰める時間', () => {
    const count = 187262;
    const city = createSyntheticCity({ size: 400, seed: 2, minHeight: 3, maxHeight: 45 });
    const growth = computePileGrowth(city.grid, [{ x: 0, z: 0, volume: count * UNIT }], ANGLE);
    const res: HeapFillResult = fillHeap({ ground: city.grid, thickness: growth.final.thickness, count, seed: 1, growth });
    console.log(
      `fillHeap full ${count}: ${res.stats.ms.toFixed(0)} ms, volume ${res.volume.toFixed(0)} m³, ` +
        `overTop ${res.stats.overTop} (max ${res.stats.maxOverTop.toFixed(2)} m), wall ${res.stats.wallContacts}, ` +
        `belowGround ${res.stats.maxBelowGround.toFixed(3)} m`,
    );
    expect(res.count).toBe(count);
    expect(res.stats.ms).toBeLessThan(15000);
  }, 60_000);

  it('15年ぶん（5,798,477台、約203万m³）を表層だけ置く台数', () => {
    const count = 5798477;
    // 平地なら直径 約281m。2m セルで 800m 四方の平らな格子。
    const ground = createHeightGrid(400, 400, 2);
    const pile = depositPiles(ground, [{ x: 0, z: 0, volume: count * UNIT }], ANGLE);
    const res = fillHeap({ ground, thickness: pile.thickness, count, seed: 1, mode: 'surface' });
    console.log(
      `fillHeap surface ${count}: placed ${res.count} (${((res.count / count) * 100).toFixed(2)}%), ` +
        `${res.stats.ms.toFixed(0)} ms, volume ${res.volume.toFixed(0)} m³, apex ${pile.piles[0]!.apexHeight.toFixed(1)} m`,
    );
    expect(res.representedCount).toBe(count);
    expect(res.count).toBeGreaterThan(100000);
    expect(res.count).toBeLessThan(count * 0.2);
  }, 120_000);
});

describe('配置への変換（layouts）', () => {
  it('heapFillToInstances: 台数・色・深さに応じた明るさと詳細度の下限', () => {
    const cs = makeCase(5000);
    const res = fillHeap({ ground: cs.ground, thickness: cs.thickness, count: cs.count, seed: 2 });
    const inst = heapFillToInstances(res, { seed: 1, buried: 'hidden', buriedDepth: 1 });
    expect(inst.count).toBe(5000);
    expect(inst.positions).toEqual(res.positions);
    const palette = new Set(FRAME_PALETTE.map((e) => e.hex));
    for (let i = 0; i < inst.count; i += 13) {
      const hex = (inst.colors[i * 3]! << 16) | (inst.colors[i * 3 + 1]! << 8) | inst.colors[i * 3 + 2]!;
      expect(palette.has(hex)).toBe(true);
      expect(inst.lodFloor![i]).toBe(res.depths[i]! >= 1 ? 3 : 0);
    }
    // 深いほど暗い（平均で比べる）
    let shallow = 0;
    let ns = 0;
    let deep = 0;
    let nd = 0;
    for (let i = 0; i < inst.count; i++) {
      if (res.depths[i]! < 0.3) {
        shallow += inst.shades![i]!;
        ns++;
      } else if (res.depths[i]! > 1.5) {
        deep += inst.shades![i]!;
        nd++;
      }
    }
    expect(shallow / ns).toBeGreaterThan(deep / nd + 40);
    // 先頭だけ使っても、各台の色は変わらない
    const head = heapFillToInstances(res, { seed: 1, limit: 100 });
    expect(head.count).toBe(100);
    expect(head.colors).toEqual(inst.colors.subarray(0, 300));
  });

  it('heapOnSurface: 容量を超えて複製した自転車も明るさを引き継ぐ', () => {
    const out = heapOnSurface({ seed: 1, count: 1000, height: () => 0.5, bounds: { minX: 0, maxX: 0.05, minZ: 0, maxZ: 0.05 } });
    const same = (a: number, b: number): boolean =>
      out.positions[a * 3] === out.positions[b * 3] &&
      out.positions[a * 3 + 1] === out.positions[b * 3 + 1] &&
      out.positions[a * 3 + 2] === out.positions[b * 3 + 2];
    let d = out.count - 1;
    while (d > 0 && same(d, d - 1)) d--;
    expect(d).toBeLessThan(out.count - 1); // 複製が起きている
    expect(out.shades![out.count - 1]).toBe(out.shades![d]);
    expect(out.lodFloor![out.count - 1]).toBe(out.lodFloor![d]);
  });
});
