/**
 * 山の場面の計算（描画に依存しない。Web Worker と Node のテストの両方から使う）。
 *
 * 1. 指定の地点を開けた地表に寄せ（`findOpenGround`）、台数 × 1台のかさ体積を安息角で積む。
 * 2. 成長の段階を求める。体積の比で等分した段階（`computePileGrowth`）に、最初の段階の中を細かく割った段階を足す
 *    （体積の 1/stages までの山は、等分の段階だけだと低く広い形に補間されるため）。
 * 3. `fillHeap` で自転車を詰める（'full' は全台、'surface' は表層だけ）。
 * 4. 描画用のデータ（位置・向き・色・陰影・山の表面との関係・出現の順位）と、
 *    段階ごとの厚さ（半精度、外接矩形 + 周囲1セル）を作る。
 *
 * 表層だけの山（'surface'）は、最終の表面から深さ `surfaceDepth`（法線方向）までに入る自転車だけを置き、
 * 描画では各自転車を「最終の位置から鉛直に spacing 刻みで下げた段のうち、現在の表面の下で最も高い段」に置く
 * （`BicycleField` の pile.mode='lattice'）。spacing はその場所の表層の鉛直の厚さなので、
 * どの進み具合でも表面から spacing までの層が自転車で埋まる。表面が spacing だけ上がるたびに一段上へ降り直す。
 */
import { DataUtils } from 'three';
import { BIKE_CENTER, BIKE_HULL, fillHeap, type HeapFillStats } from '../../sim/heapFill';
import { findOpenGround, type HeightGrid } from '../../sim/heightGrid';
import { computePileGrowth, type PileGrowth, type PileSource } from '../../sim/pile';
import { pickFrameColor } from '../bicycle/geometry';

export type PileMode = 'full' | 'surface';

export interface PileComputeParams {
  /** 山の地点（緯度経度は呼び出し側でローカル座標にしておく）。 */
  x: number;
  z: number;
  /** 山全体が表す台数。 */
  count: number;
  mode: PileMode;
  /** 1台あたりのかさ体積(m³)。既定 0.35。 */
  unitVolume?: number;
  /** 安息角(度)。既定 35。 */
  angle?: number;
  /** 乱数の種。既定 1。 */
  seed?: number;
  /** 'surface' の表層の深さ（法線方向, m）。既定 0.8。 */
  surfaceDepth?: number;
  /** 体積で等分した成長の段階の数。既定 24。 */
  stages?: number;
  /** 最初の段階の中を割る数。既定 8。 */
  earlyStages?: number;
  /** 開けた地表の判定（`findOpenGround`）。既定 半径 6 セル・1.5m。 */
  openGround?: { radiusCells?: number; threshold?: number; maxDistance?: number };
  /** 陰影に使う光の向き（光源へ向かう向き）。既定は `createPlateauStage` の太陽 (-300, 600, 400)。 */
  sunDirection?: { x: number; y: number; z: number };
}

export interface PileComputeProgress {
  phase: 'load' | 'deposit' | 'fill' | 'prepare' | 'done';
  /** 全体の進み具合の目安（0〜1）。 */
  fraction: number;
}

export interface PileComputeTimings {
  loadMs: number;
  depositMs: number;
  fillMs: number;
  prepareMs: number;
  totalMs: number;
}

/** 計算結果（TypedArray はすべて Worker から転送できる）。 */
export interface PileComputeResult {
  mode: PileMode;
  /** 開けた地表に寄せた山の地点（投入点）。 */
  site: { x: number; z: number; groundY: number; shiftedBy: number };
  /** 頂上（ローカル Y = 標高, m）と、投入点の地表からの高さ(m)。 */
  apexY: number;
  apexHeight: number;
  /** 堆積の体積(m³)と面積(m²)。 */
  volume: number;
  area: number;
  /** 山全体が表す台数。 */
  representedCount: number;
  /** 実際に置いた台数。 */
  placedCount: number;
  /** 位置の基準点（ローカル座標）。positions はここからの相対値。 */
  origin: { x: number; y: number; z: number };
  positions: Float32Array;
  quaternions: Float32Array;
  colors: Uint8Array;
  shades: Uint8Array;
  /** 最終の位置での中心の、地表からの高さ(m)。 */
  pileHeight: Float32Array;
  /** 'surface': 降り直しの間隔（鉛直, m）と段数の上限。'full' では空。 */
  spacing: Float32Array;
  maxLevel: Float32Array;
  /**
   * 'full': この台数より多く表示したら、その自転車は表面から {@link HIDE_DEPTH} より深く埋もれる（描かない）。
   * 最後まで埋もれない自転車は 1e30。'surface' では空。
   */
  hideAfter: Float32Array;
  /** 出現の順位ごとの進み具合（昇順）。'full' は中心が覆われる進み具合、'surface' は最初に現れる進み具合。 */
  arrivals: Float32Array;
  /** 成長の段階の体積比（昇順、先頭 0・末尾 1）。 */
  fractions: Float32Array;
  /** 段階ごとの厚さ（半精度の Uint16、層 × layerHeight × layerWidth）。 */
  layers: Uint16Array;
  layerWidth: number;
  layerHeight: number;
  /** 層の範囲（北西の角とセルの一辺）。テクセルの中心がセルの中心。 */
  layerRect: { x0: number; z0: number; cellSize: number };
  /** 層の範囲の地表の高さ（屋上を含む, m）。暗い面に使う。 */
  layerGround: Float32Array;
  fillStats: HeapFillStats;
  timings: PileComputeTimings;
}

/** 計算に使う既定値。 */
export const PILE_DEFAULTS = {
  unitVolume: 0.35,
  angle: 35,
  seed: 1,
  surfaceDepth: 0.8,
  stages: 24,
  earlyStages: 8,
} as const;

/** 'full' で描かなくなる、現在の表面からの鉛直の深さ(m)。 */
export const HIDE_DEPTH = 1.6;

/** 整数 i と種から 0 以上 1 未満の値。 */
export function hash01(seed: number, i: number, salt: number): number {
  let h = Math.imul(i ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 段階を細かくした成長（`PileGrowth` と同じ形）。layers は外接矩形の範囲だけ。 */
interface MergedGrowth extends PileGrowth {
  layers: Float32Array[];
}

/**
 * 成長の段階を求める。体積で等分した段階の最初の区間 [0, 1/stages] を、
 * その体積の山の成長（earlyStages 段階）で置き換える。
 */
export function computeDetailedGrowth(
  ground: HeightGrid,
  source: PileSource,
  angle: number,
  stages: number,
  earlyStages: number,
): MergedGrowth {
  const main = computePileGrowth(ground, [source], angle, { stages });
  const { col0, row0, col1, row1 } = main.bounds;
  const bw = Math.max(0, col1 - col0 + 1);
  const bh = Math.max(0, row1 - row0 + 1);
  const w = ground.width;
  const crop = (full: Float32Array): Float32Array => {
    const out = new Float32Array(bw * bh);
    for (let r = 0; r < bh; r++) out.set(full.subarray((row0 + r) * w + col0, (row0 + r) * w + col0 + bw), r * bw);
    return out;
  };
  const f1 = (main.fractions[1] as number) || 1;
  const fractions: number[] = [0];
  const layers: Float32Array[] = [new Float32Array(bw * bh)];
  const full = new Float32Array(w * ground.height);
  if (earlyStages > 1 && stages > 1) {
    const early = computePileGrowth(ground, [{ ...source, volume: source.volume * f1 }], angle, { stages: earlyStages });
    for (let k = 1; k < early.fractions.length - 1; k++) {
      fractions.push((early.fractions[k] as number) * f1);
      layers.push(crop(early.thicknessAt(early.fractions[k] as number, full)));
    }
  }
  for (let k = 1; k < main.fractions.length; k++) {
    fractions.push(main.fractions[k] as number);
    layers.push(crop(main.thicknessAt(main.fractions[k] as number, full)));
  }
  // 前の段より薄くならず、最終より厚くならないようにする
  const last = layers[layers.length - 1] as Float32Array;
  for (let k = 1; k < layers.length; k++) {
    const l = layers[k] as Float32Array;
    const prev = layers[k - 1] as Float32Array;
    for (let j = 0; j < l.length; j++) {
      const v = Math.min(l[j] as number, last[j] as number);
      l[j] = v < (prev[j] as number) ? (prev[j] as number) : v;
    }
  }
  const F = Float64Array.from(fractions);
  const K = F.length;
  const thicknessAt = (tIn: number, out?: Float32Array): Float32Array => {
    const t = Math.min(1, Math.max(0, Number.isFinite(tIn) ? tIn : 0));
    const res = out ?? new Float32Array(w * ground.height);
    if (out) res.fill(0);
    if (bw <= 0 || bh <= 0) return res;
    const { k, a } = stageAt(F, t);
    const l0 = layers[k] as Float32Array;
    const l1 = layers[Math.min(K - 1, k + 1)] as Float32Array;
    for (let r = 0; r < bh; r++) {
      const base = (row0 + r) * w + col0;
      for (let c = 0; c < bw; c++) {
        const j = r * bw + c;
        const v0 = l0[j] as number;
        res[base + c] = v0 + ((l1[j] as number) - v0) * a;
      }
    }
    return res;
  };
  return { fractions: F, final: main.final, bounds: main.bounds, thicknessAt, layers };
}

/** 進み具合 t を含む段階の区間 [k, k+1] と、その中の割合 a。 */
export function stageAt(fractions: ArrayLike<number>, t: number): { k: number; a: number } {
  const K = fractions.length;
  if (K < 2) return { k: 0, a: 0 };
  let lo = 0;
  let hi = K - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((fractions[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  const f0 = fractions[lo] as number;
  const f1 = fractions[lo + 1] as number;
  const a = f1 > f0 ? Math.min(1, Math.max(0, (t - f0) / (f1 - f0))) : 1;
  return { k: lo, a };
}

/** 昇順の配列で value 以下の要素の数。 */
export function countAtMost(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** セル j の厚さが value に達する進み具合（段階の間は線形）。最終でも届かなければ 1。 */
function crossingTime(layers: Float32Array[], fractions: Float64Array, j: number, value: number): number {
  if (value <= 0) return 0;
  let prevT = 0;
  let prevF = 0;
  for (let k = 0; k < layers.length; k++) {
    const t = (layers[k] as Float32Array)[j] as number;
    const f = fractions[k] as number;
    if (t >= value) return k > 0 && t > prevT ? prevF + ((value - prevT) / (t - prevT)) * (f - prevF) : f;
    prevT = t;
    prevF = f;
  }
  return 1;
}

/** q で回した v。 */
function rotate(q: ArrayLike<number>, o: number, vx: number, vy: number, vz: number): [number, number, number] {
  const qx = q[o] as number;
  const qy = q[o + 1] as number;
  const qz = q[o + 2] as number;
  const qw = q[o + 3] as number;
  const cx = qy * vz - qz * vy + qw * vx;
  const cy = qz * vx - qx * vz + qw * vy;
  const cz = qx * vy - qy * vx + qw * vz;
  return [vx + 2 * (qy * cz - qz * cy), vy + 2 * (qz * cx - qx * cz), vz + 2 * (qx * cy - qy * cx)];
}

/**
 * 山の場面の計算の本体。
 * @param ground 地表（屋上を含む）の高さ格子
 */
export function computePileScene(
  ground: HeightGrid,
  params: PileComputeParams,
  onProgress?: (p: PileComputeProgress) => void,
  loadMs = 0,
): PileComputeResult {
  const tStart = performance.now();
  const unitVolume = params.unitVolume ?? PILE_DEFAULTS.unitVolume;
  const angle = params.angle ?? PILE_DEFAULTS.angle;
  const seed = params.seed ?? PILE_DEFAULTS.seed;
  const surfaceDepth = params.surfaceDepth ?? PILE_DEFAULTS.surfaceDepth;
  const stages = Math.max(1, Math.floor(params.stages ?? PILE_DEFAULTS.stages));
  const earlyStages = Math.max(1, Math.floor(params.earlyStages ?? PILE_DEFAULTS.earlyStages));
  const count = Math.max(1, Math.floor(params.count));
  const mode = params.mode;

  // 1. 地点と堆積
  onProgress?.({ phase: 'deposit', fraction: 0.1 });
  const open = findOpenGround(ground, params.x, params.z, {
    radiusCells: params.openGround?.radiusCells ?? 6,
    threshold: params.openGround?.threshold ?? 1.5,
    maxDistance: params.openGround?.maxDistance ?? 300,
  });
  if (!open) throw new Error('山を積む開けた地表が見つかりません');
  const W = ground.width;
  const cs = ground.cellSize;
  const groundY = ground.data[open.row * W + open.col] as number;
  const volume = count * unitVolume;
  const growth = computeDetailedGrowth(ground, { x: open.x, z: open.z, volume }, angle, stages, earlyStages);
  const final = growth.final;
  const pile0 = final.piles[0];
  const tDeposit = performance.now();

  // 2. 充填
  onProgress?.({ phase: 'fill', fraction: 0.4 });
  const fill = fillHeap({
    ground,
    thickness: final.thickness,
    count,
    unitVolume,
    seed,
    mode: mode === 'surface' ? 'surface' : 'full',
    surfaceDepth,
    growth,
  });
  const tFill = performance.now();

  // 3. 描画用のデータ
  onProgress?.({ phase: 'prepare', fraction: 0.85 });
  const { col0, row0, col1, row1 } = growth.bounds;
  const bw = col1 - col0 + 1;
  const bh = row1 - row0 + 1;
  const n = fill.count;
  const sun = params.sunDirection ?? { x: -300, y: 600, z: 400 };
  const sl = Math.hypot(sun.x, sun.y, sun.z);
  const L = [sun.x / sl, sun.y / sl, sun.z / sl] as const;
  const layers = growth.layers;
  const F = growth.fractions;

  // 段階ごとの表面の勾配（必要になった段階だけ求める）
  const gradCache = new Map<number, Float32Array>();
  const gradAt = (k: number): Float32Array => {
    let g = gradCache.get(k);
    if (g) return g;
    const layer = layers[k] as Float32Array;
    g = new Float32Array(bw * bh * 2);
    const surf = (c: number, r: number): number => {
      const cc = Math.min(bw - 1, Math.max(0, c));
      const rr = Math.min(bh - 1, Math.max(0, r));
      return (ground.data[(row0 + rr) * W + col0 + cc] as number) + (layer[rr * bw + cc] as number);
    };
    for (let r = 0; r < bh; r++) {
      for (let c = 0; c < bw; c++) {
        const j = r * bw + c;
        const here = surf(c, r);
        // 堆積のない隣（建物の壁など）は自分の値で代用する
        const pick = (cc: number, rr: number): number => {
          if (cc < 0 || rr < 0 || cc >= bw || rr >= bh) return here;
          return (layer[rr * bw + cc] as number) > 0 ? surf(cc, rr) : here;
        };
        g[j * 2] = (pick(c + 1, r) - pick(c - 1, r)) / (2 * cs);
        g[j * 2 + 1] = (pick(c, r + 1) - pick(c, r - 1)) / (2 * cs);
      }
    }
    gradCache.set(k, g);
    return g;
  };

  const origin = { x: Math.round(open.x), y: Math.round(groundY), z: Math.round(open.z) };
  const positions = new Float32Array(n * 3);
  const quaternions = fill.quaternions;
  const colors = new Uint8Array(n * 3);
  const shades = new Uint8Array(n);
  const pileHeight = new Float32Array(n);
  const spacing = new Float32Array(mode === 'surface' ? n : 0);
  const maxLevel = new Float32Array(mode === 'surface' ? n : 0);
  let arrivals = fill.arrivals;
  const firstArrival = new Float32Array(mode === 'surface' ? n : 0);
  const lastLayer = layers.length - 1;
  const cellOf = new Int32Array(n);
  const [cx0, cy0, cz0] = BIKE_CENTER;
  for (let i = 0; i < n; i++) {
    positions[i * 3] = (fill.positions[i * 3] as number) - origin.x;
    positions[i * 3 + 1] = (fill.positions[i * 3 + 1] as number) - origin.y;
    positions[i * 3 + 2] = (fill.positions[i * 3 + 2] as number) - origin.z;
    const cx = fill.centers[i * 3] as number;
    const cy = fill.centers[i * 3 + 1] as number;
    const cz = fill.centers[i * 3 + 2] as number;
    const c = Math.min(bw - 1, Math.max(0, Math.floor((cx - ground.originX) / cs) - col0));
    const r = Math.min(bh - 1, Math.max(0, Math.floor((cz - ground.originZ) / cs) - row0));
    const j = r * bw + c;
    cellOf[i] = j;
    const g = ground.data[(row0 + r) * W + col0 + c] as number;
    const h = cy - g;
    pileHeight[i] = h;

    // 陰影: 自転車が表面にいる段階の、表面の向き（'surface' は最終の表面）
    const k = mode === 'surface' ? lastLayer : Math.min(lastLayer, stageAt(F, arrivals[i] as number).k + 1);
    const grad = gradAt(k);
    const gx = grad[j * 2] as number;
    const gz = grad[j * 2 + 1] as number;
    const nl = Math.hypot(gx, 1, gz);
    const ndl = (-gx * L[0] + L[1] - gz * L[2]) / nl;
    const shade = Math.min(1, Math.max(0.3, 0.35 + (0.65 * Math.max(0, ndl)) / L[1])) * (0.86 + 0.14 * hash01(seed, i, 1));
    shades[i] = Math.round(shade * 255);
    const hex = pickFrameColor(hash01(seed, i, 0));
    colors[i * 3] = (hex >> 16) & 255;
    colors[i * 3 + 1] = (hex >> 8) & 255;
    colors[i * 3 + 2] = hex & 255;

    if (mode === 'surface') {
      // 表層の鉛直の厚さ（fillHeap と同じ: 法線方向の深さ ÷ cos(勾配)）。最終の勾配を使う。
      const gf = gradAt(lastLayer);
      const fx = gf[j * 2] as number;
      const fz = gf[j * 2 + 1] as number;
      const D = surfaceDepth * Math.sqrt(1 + fx * fx + fz * fz);
      // 平らな地面に置いたときに代表点が地表より上に出る中心の高さ
      let clearance = 0;
      for (const p of BIKE_HULL) {
        const [, ry] = rotate(quaternions, i * 4, p[0] - cx0, p[1] - cy0, p[2] - cz0);
        if (-ry > clearance) clearance = -ry;
      }
      clearance += 0.01;
      const levels = Math.max(0, Math.floor((h - clearance) / D));
      spacing[i] = D;
      maxLevel[i] = levels;
      firstArrival[i] = crossingTime(layers, F, j, h - levels * D);
    }
  }

  // 'full' は埋もれる時期（表示台数）
  const hideAfter = new Float32Array(mode === 'full' ? n : 0);
  if (mode === 'full') {
    const lastL = layers[lastLayer] as Float32Array;
    for (let i = 0; i < n; i++) {
      const j = cellOf[i] as number;
      const target = (pileHeight[i] as number) + HIDE_DEPTH;
      hideAfter[i] = (lastL[j] as number) < target ? 1e30 : countAtMost(arrivals, crossingTime(layers, F, j, target));
    }
  }

  // 'surface' は最初に現れる順に並べ替える
  let order: Uint32Array | null = null;
  if (mode === 'surface') {
    order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => (firstArrival[a] as number) - (firstArrival[b] as number) || a - b);
    arrivals = new Float32Array(n);
    for (let m = 0; m < n; m++) arrivals[m] = firstArrival[order[m] as number] as number;
  }
  const permute = <T extends Float32Array | Uint8Array>(src: T, stride: number): T => {
    if (!order) return src;
    const out = new (src.constructor as { new (len: number): T })(src.length);
    for (let m = 0; m < n; m++) {
      const o = order[m] as number;
      for (let s = 0; s < stride; s++) out[m * stride + s] = src[o * stride + s] as number;
    }
    return out;
  };

  // 段階ごとの厚さ（周囲に1セルの 0 を足した範囲, 半精度）
  const lw = bw + 2;
  const lh = bh + 2;
  const half = new Uint16Array(layers.length * lw * lh);
  layers.forEach((layer, k) => {
    const base = k * lw * lh;
    for (let r = 0; r < bh; r++) {
      for (let c = 0; c < bw; c++) half[base + (r + 1) * lw + c + 1] = DataUtils.toHalfFloat(layer[r * bw + c] as number);
    }
  });
  const layerGround = new Float32Array(lw * lh);
  for (let r = 0; r < lh; r++) {
    const rr = Math.min(ground.height - 1, Math.max(0, row0 + r - 1));
    for (let c = 0; c < lw; c++) {
      const cc = Math.min(W - 1, Math.max(0, col0 + c - 1));
      const v = ground.data[rr * W + cc] as number;
      layerGround[r * lw + c] = Number.isNaN(v) ? groundY : v;
    }
  }
  const tEnd = performance.now();
  onProgress?.({ phase: 'done', fraction: 1 });

  return {
    mode,
    site: { x: open.x, z: open.z, groundY, shiftedBy: open.distance },
    apexY: pile0?.apexY ?? Number.NaN,
    apexHeight: pile0?.apexHeight ?? Number.NaN,
    volume: fill.volume,
    area: pile0?.area ?? 0,
    representedCount: count,
    placedCount: n,
    origin,
    positions: permute(positions, 3),
    quaternions: permute(quaternions, 4),
    colors: permute(colors, 3),
    shades: permute(shades, 1),
    pileHeight: permute(pileHeight, 1),
    spacing: permute(spacing, 1),
    maxLevel: permute(maxLevel, 1),
    hideAfter,
    arrivals,
    fractions: Float32Array.from(F),
    layers: half,
    layerWidth: lw,
    layerHeight: lh,
    layerRect: { x0: ground.originX + (col0 - 1) * cs, z0: ground.originZ + (row0 - 1) * cs, cellSize: cs },
    layerGround,
    fillStats: fill.stats,
    timings: {
      loadMs,
      depositMs: tDeposit - tStart,
      fillMs: tFill - tDeposit,
      prepareMs: tEnd - tFill,
      totalMs: loadMs + (tEnd - tStart),
    },
  };
}

/** 結果のうち Worker から転送する ArrayBuffer。 */
export function transferablesOf(r: PileComputeResult): ArrayBuffer[] {
  const arrays = [r.positions, r.quaternions, r.colors, r.shades, r.pileHeight, r.spacing, r.maxLevel, r.hideAfter, r.arrivals, r.fractions, r.layers, r.layerGround];
  const set = new Set<ArrayBuffer>();
  for (const a of arrays) if (a.buffer instanceof ArrayBuffer) set.add(a.buffer);
  return [...set];
}

/**
 * 表層の降り直し（`BicycleField` の pile.mode='lattice'）で、1台の自転車をどの段に置くか。
 * 頂点シェーダーと同じ計算（単体テストと説明のため）。
 * @param height 最終の位置での中心の、地表からの高さ(m)
 * @param spacing 段の間隔（鉛直, m）
 * @param maxLevel 下げてよい段数の上限
 * @param headThickness 現在の（先頭の）表面の厚さ(m)
 * @param lagThickness 遅れの表面の厚さ(m)（先頭以下）
 * @param window 降り直しの落下にかける幅（spacing に対する割合）
 * @returns hidden: 描かない、level: 下げる段数、fall: 落下の進み具合（1=着地）、depth: 現在の表面からの鉛直の深さ
 */
export function latticeState(
  height: number,
  spacing: number,
  maxLevel: number,
  headThickness: number,
  lagThickness = headThickness,
  window = 1,
): { hidden: boolean; level: number; fall: number; depth: number } {
  const D = Math.max(spacing, 1e-3);
  const m1 = Math.max(0, Math.ceil((height - headThickness) / D - 1e-4));
  const mL = Math.max(m1, Math.ceil((height - lagThickness) / D - 1e-4));
  let hidden = m1 > maxLevel + 0.5;
  let level = m1;
  let fall = 1;
  if (mL > m1 + 0.5) {
    const q = 1 - (height - m1 * D - lagThickness) / (Math.max(window, 1e-3) * D);
    if (q > 0) fall = Math.min(1, q);
    else {
      level = mL;
      if (mL > maxLevel + 0.5) hidden = true;
    }
  }
  return { hidden, level, fall, depth: headThickness - (height - level * D) };
}
