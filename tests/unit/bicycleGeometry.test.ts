import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import {
  FRAME_PALETTE,
  LOD_TRIANGLE_BUDGET,
  createBicycleGeometry,
  pickFrameColor,
  triangleCount,
  type BicycleLod,
} from '../../src/scene/bicycle/geometry';

const LODS: BicycleLod[] = [0, 1, 2];

describe('ママチャリ形状', () => {
  it.each(LODS)('LOD%i は三角形数の上限以内', (lod) => {
    const geo = createBicycleGeometry(lod);
    const n = triangleCount(geo);
    console.log(`LOD${lod}: ${n} triangles`);
    expect(n).toBeLessThanOrEqual(LOD_TRIANGLE_BUDGET[lod]);
    expect(n).toBeGreaterThan(LOD_TRIANGLE_BUDGET[lod] * 0.5);
  });

  it('近景は実寸（全長1.8m・幅0.6m・高さ1.05m）で原点が接地面の中央', () => {
    const geo = createBicycleGeometry(0);
    const bb = geo.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(1.8, 1);
    expect(bb.max.z - bb.min.z).toBeCloseTo(0.6, 1);
    expect(bb.max.y).toBeCloseTo(1.05, 1);
    expect(bb.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(bb.min.y).toBeLessThan(0.01);
    expect(Math.abs(bb.max.x + bb.min.x)).toBeLessThan(0.05);
  });

  it('遠景・中景の外形は近景とほぼ一致する', () => {
    const near = createBicycleGeometry(0).boundingBox!;
    for (const lod of [1, 2] as const) {
      const bb = createBicycleGeometry(lod).boundingBox!;
      expect(Math.abs(bb.min.x - near.min.x)).toBeLessThan(0.08);
      expect(Math.abs(bb.max.x - near.max.x)).toBeLessThan(0.08);
      expect(Math.abs(bb.max.y - near.max.y)).toBeLessThan(0.08);
      expect(bb.min.y).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it('頂点属性 color と frameMask を持ち、フレーム部分が存在する', () => {
    for (const lod of LODS) {
      const geo = createBicycleGeometry(lod);
      const mask = geo.getAttribute('frameMask');
      expect(geo.getAttribute('color').count).toBe(mask.count);
      let frame = 0;
      for (let i = 0; i < mask.count; i++) frame += mask.getX(i);
      expect(frame).toBeGreaterThan(0);
      expect(frame).toBeLessThan(mask.count);
    }
  });

  it('パレットの割合は合計1で、乱数に応じて全色が選ばれうる', () => {
    const sum = FRAME_PALETTE.reduce((a, e) => a + e.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(pickFrameColor(i / 1000));
    expect(seen.size).toBe(FRAME_PALETTE.length);
    expect(pickFrameColor(0.999999)).toBe(FRAME_PALETTE[FRAME_PALETTE.length - 1]!.hex);
  });
});

// ---------------------------------------------------------------------------
// 面の向き

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function vertex(geo: BufferGeometry, name: string, i: number): V3 {
  const a = geo.getAttribute(name);
  return [a.getX(i), a.getY(i), a.getZ(i)];
}

function triangles(geo: BufferGeometry): Array<[number, number, number]> {
  const idx = geo.getIndex()!;
  const out: Array<[number, number, number]> = [];
  for (let t = 0; t < idx.count; t += 3) out.push([idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]);
  return out;
}

/** 頂点を共有する三角形の連結成分（部品）。 */
function components(geo: BufferGeometry): number[][] {
  const tris = triangles(geo);
  const parent = Array.from({ length: geo.getAttribute('position').count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (const [a, b, c] of tris) {
    parent[find(b)] = find(a);
    parent[find(c)] = find(a);
  }
  const groups = new Map<number, number[]>();
  tris.forEach(([a], t) => {
    const r = find(a);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(t);
  });
  return [...groups.values()];
}

describe('面の向き', () => {
  it.each(LODS)('LOD%i: 頂点の法線は三角形の巻き順の向きと一致する', (lod) => {
    const geo = createBicycleGeometry(lod);
    let bad = 0;
    for (const [a, b, c] of triangles(geo)) {
      const pa = vertex(geo, 'position', a);
      const n = cross(sub(vertex(geo, 'position', b), pa), sub(vertex(geo, 'position', c), pa));
      if (Math.hypot(...n) < 1e-12) continue;
      for (const k of [a, b, c]) if (dot(n, vertex(geo, 'normal', k)) <= 0) bad++;
    }
    expect(bad).toBe(0);
  });

  it.each(LODS)('LOD%i: 各部品の面は部品の中心から外を向く', (lod) => {
    const geo = createBicycleGeometry(lod);
    const tris = triangles(geo);
    for (const comp of components(geo)) {
      // 部品の中心（面積で重みづけした三角形の重心）
      let area = 0;
      const center: V3 = [0, 0, 0];
      const data = comp.map((t) => {
        const [a, b, c] = tris[t]!;
        const pa = vertex(geo, 'position', a);
        const pb = vertex(geo, 'position', b);
        const pc = vertex(geo, 'position', c);
        const n = cross(sub(pb, pa), sub(pc, pa));
        const ar = Math.hypot(...n) / 2;
        const g: V3 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
        area += ar;
        for (let k = 0; k < 3; k++) center[k] = center[k]! + g[k]! * ar;
        return { n, g };
      });
      if (area < 1e-12) continue;
      for (let k = 0; k < 3; k++) center[k] = center[k]! / area;
      // 外向きなら Σ n·(g − center) > 0（閉じた面では体積の 3 倍）。平面の部品は 0。
      let flux = 0;
      let scale = 0;
      for (const { n, g } of data) {
        const d = sub(g, center);
        flux += dot(n, d);
        scale += Math.hypot(...n) * Math.hypot(...d);
      }
      expect(flux).toBeGreaterThanOrEqual(-1e-6 * Math.max(1, scale));
    }
  });
});

// ---------------------------------------------------------------------------
// 詳細度ごとの見た目（正射影で三角形を塗り、画面上の面積と平均色を比べる）

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToLinear = (hex: number): V3 => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];

interface Appearance {
  /** 画面上で覆う面積(m²)。 */
  area: number;
  /** 覆う画素の平均色（線形 RGB、陰影なしの地の色）。 */
  mean: V3;
  /** 覆う画素のうちフレーム色・明るい部品（銀など）・暗い部品（タイヤなど）の割合。 */
  frame: number;
  light: number;
  dark: number;
}

/**
 * 形状を視線の方向 dir（物体からカメラへ）から正射影で塗る。画素の一辺は px(m)。
 * 奥行きの判定（z バッファ）つきで、見えている面の頂点カラー（フレーム部分はフレーム色）を集計する。
 */
function appearance(geo: BufferGeometry, dir: V3, frameHex: number, px = 0.004): Appearance {
  const len = Math.hypot(...dir);
  const f: V3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  const upRef: V3 = Math.abs(f[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const r0 = cross(upRef, f);
  const rl = Math.hypot(...r0);
  const right: V3 = [r0[0] / rl, r0[1] / rl, r0[2] / rl];
  const up = cross(f, right);
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  const mask = geo.getAttribute('frameMask');
  const frame = hexToLinear(frameHex);
  const n = pos.count;
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const sz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p: V3 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    sx[i] = dot(p, right) / px;
    sy[i] = dot(p, up) / px;
    sz[i] = dot(p, f);
  }
  const R = Math.ceil(1.3 / px);
  const W = 2 * R;
  const depth = new Float64Array(W * W).fill(-Infinity);
  const owner = new Int32Array(W * W).fill(-1);
  const tris = triangles(geo);
  tris.forEach(([a, b, c], t) => {
    const ax = sx[a]! + R;
    const ay = sy[a]! + R;
    const bx = sx[b]! + R;
    const by = sy[b]! + R;
    const cx = sx[c]! + R;
    const cy = sy[c]! + R;
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(d) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(W - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5;
        const qy = y + 0.5;
        const wa = ((bx - qx) * (cy - qy) - (cx - qx) * (by - qy)) / d;
        const wb = ((cx - qx) * (ay - qy) - (ax - qx) * (cy - qy)) / d;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const z = wa * sz[a]! + wb * sz[b]! + wc * sz[c]!;
        const k = y * W + x;
        if (z > depth[k]!) {
          depth[k] = z;
          owner[k] = t;
        }
      }
    }
  });
  let count = 0;
  const sum: V3 = [0, 0, 0];
  let fr = 0;
  let li = 0;
  let da = 0;
  for (let k = 0; k < W * W; k++) {
    const t = owner[k]!;
    if (t < 0) continue;
    const [a] = tris[t]!;
    const m = mask.getX(a);
    const c: V3 = [col.getX(a), col.getY(a), col.getZ(a)];
    const rgb: V3 = m > 0.5 ? [c[0] * frame[0], c[1] * frame[1], c[2] * frame[2]] : c;
    count++;
    for (let i = 0; i < 3; i++) sum[i] = sum[i]! + rgb[i]!;
    if (m > 0.5) fr++;
    else if ((c[0] + c[1] + c[2]) / 3 > 0.15) li++;
    else da++;
  }
  return {
    area: count * px * px,
    mean: [sum[0] / count, sum[1] / count, sum[2] / count],
    frame: fr / count,
    light: li / count,
    dark: da / count,
  };
}

/** 2つの平均色の差（sRGB 0-255 の距離）。 */
function colorDiff(a: V3, b: V3): number {
  return Math.hypot(...a.map((v, i) => (linearToSrgb(v) - linearToSrgb(b[i]!)) * 255));
}

/**
 * 比べる視点（物体からカメラへの向き）。
 * 「前」は真正面（進行方向の先）から見た像。遠景の部品は大半が車体の面（XY 平面）にあり、
 * 真正面からは縁しか見えないので、許容を広げる。
 */
const VIEWS: Array<{ name: string; dir: V3; areaTol: number; colorTol: number }> = [
  { name: '側面', dir: [0, 0, 1], areaTol: 0.2, colorTol: 20 },
  { name: '斜め上', dir: [0.5, 1, 0.7], areaTol: 0.2, colorTol: 20 },
  { name: '斜め上（後ろ左）', dir: [-0.6, 0.8, -0.6], areaTol: 0.2, colorTol: 20 },
  { name: '真上', dir: [0, 1, 0], areaTol: 0.2, colorTol: 20 },
  { name: '前', dir: [1, 0, 0], areaTol: 0.3, colorTol: 30 },
];
const TEST_FRAMES = [
  { name: '紺', hex: 0x1d2a52 },
  { name: '銀', hex: 0xb4b8bd },
  { name: '赤', hex: 0xa3201f },
];

interface AppearanceRow {
  view: string;
  areaTol: number;
  colorTol: number;
  frame: string;
  lod: 1 | 2;
  areaRatio: number;
  colorDiff: number;
  text: string;
}

/** 視点・フレーム色・詳細度ごとの、近景との面積比と平均色の差。 */
function appearanceTable(): AppearanceRow[] {
  const geos = LODS.map((lod) => createBicycleGeometry(lod));
  const rows: AppearanceRow[] = [];
  const pct = (v: number): string => `${Math.round(v * 100)}`;
  for (const view of VIEWS) {
    for (const frame of TEST_FRAMES) {
      const ap = geos.map((g) => appearance(g, view.dir, frame.hex));
      const near = ap[0]!;
      for (const lod of [1, 2] as const) {
        const a = ap[lod]!;
        const areaRatio = a.area / near.area;
        const dc = colorDiff(a.mean, near.mean);
        rows.push({
          view: view.name,
          areaTol: view.areaTol,
          colorTol: view.colorTol,
          frame: frame.name,
          lod,
          areaRatio,
          colorDiff: dc,
          text:
            `${view.name}\t${frame.name}\tLOD${lod}\t面積比 ${areaRatio.toFixed(3)}\t色差 ${dc.toFixed(1)}` +
            `\tフレーム/明/暗(%) ${pct(a.frame)}/${pct(a.light)}/${pct(a.dark)}` +
            `（近景 ${pct(near.frame)}/${pct(near.light)}/${pct(near.dark)}）`,
        });
      }
    }
  }
  // 全方向（球面上にほぼ一様な 40 方向）の平均。山の中のばらばらな向きの見え方に当たる。
  const dirs: V3[] = [];
  const M = 40;
  for (let i = 0; i < M; i++) {
    const y = 1 - (2 * (i + 0.5)) / M;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    dirs.push([r * Math.cos(phi), y, r * Math.sin(phi)]);
  }
  for (const frame of TEST_FRAMES) {
    const acc = geos.map(() => ({ area: 0, sum: [0, 0, 0] as V3 }));
    for (const d of dirs) {
      geos.forEach((g, lod) => {
        const a = appearance(g, d, frame.hex, 0.008);
        const s = acc[lod]!;
        s.area += a.area / M;
        for (let k = 0; k < 3; k++) s.sum[k] = s.sum[k]! + (a.mean[k]! * a.area) / M;
      });
    }
    const mean = (s: { area: number; sum: V3 }): V3 => [s.sum[0] / s.area, s.sum[1] / s.area, s.sum[2] / s.area];
    for (const lod of [1, 2] as const) {
      const areaRatio = acc[lod]!.area / acc[0]!.area;
      const dc = colorDiff(mean(acc[lod]!), mean(acc[0]!));
      rows.push({
        view: '全方向の平均',
        areaTol: 0.2,
        colorTol: 20,
        frame: frame.name,
        lod,
        areaRatio,
        colorDiff: dc,
        text: `全方向の平均\t${frame.name}\tLOD${lod}\t面積比 ${areaRatio.toFixed(3)}\t色差 ${dc.toFixed(1)}`,
      });
    }
  }
  return rows;
}

describe('詳細度ごとの見た目', () => {
  const rows = appearanceTable();
  it('一覧を表示する', () => {
    console.log(rows.map((r) => r.text).join('\n'));
  });
  it.each(rows.map((r) => [`${r.view}・${r.frame}・LOD${r.lod}`, r] as const))(
    '%s: 面積と平均色が近景に近い',
    (_name, r) => {
      expect(Math.abs(r.areaRatio - 1)).toBeLessThan(r.areaTol);
      expect(r.colorDiff).toBeLessThan(r.colorTol);
    },
  );
});
