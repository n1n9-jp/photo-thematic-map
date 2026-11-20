/**
 * 確認用の自転車の配置を作る。乱数の種を与えれば結果は再現できる。
 *
 * - `parkedRows`: 駅前の歩道に並んだ駐輪の列。
 * - `heapOnSurface`: 高さ関数の表面に沿って、向きがばらばらで互いにもたれ合う山積み。
 * - `singleBicycle`: 1台を置く。
 * - `concatInstances`: 複数の配置を1つにまとめる。
 */
import { Quaternion, Vector3 } from 'three';
import type { BicycleInstances } from './field';
import { pickFrameColor } from './geometry';

/** 再現可能な乱数（mulberry32）。0 以上 1 未満を返す関数を作る。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 空の配置を確保する。 */
export function allocateInstances(count: number): BicycleInstances {
  return {
    count,
    positions: new Float32Array(count * 3),
    quaternions: new Float32Array(count * 4),
    colors: new Uint8Array(count * 3),
    shades: new Uint8Array(count).fill(255),
    lodFloor: new Uint8Array(count),
  };
}

function writeInstance(out: BicycleInstances, i: number, p: Vector3, q: Quaternion, colorHex: number, shade = 1): void {
  out.positions[i * 3] = p.x;
  out.positions[i * 3 + 1] = p.y;
  out.positions[i * 3 + 2] = p.z;
  out.quaternions[i * 4] = q.x;
  out.quaternions[i * 4 + 1] = q.y;
  out.quaternions[i * 4 + 2] = q.z;
  out.quaternions[i * 4 + 3] = q.w;
  out.colors[i * 3] = (colorHex >> 16) & 255;
  out.colors[i * 3 + 1] = (colorHex >> 8) & 255;
  out.colors[i * 3 + 2] = colorHex & 255;
  if (out.shades) out.shades[i] = Math.round(Math.min(1, Math.max(0, shade)) * 255);
}

const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);
const Z_AXIS = new Vector3(0, 0, 1);

/** 1台を置く。yaw は Y 軸まわりの回転（ラジアン、0 で +X 向き）。 */
export function singleBicycle(position: { x: number; y: number; z: number }, yaw: number, colorHex: number): BicycleInstances {
  const out = allocateInstances(1);
  writeInstance(out, 0, new Vector3(position.x, position.y, position.z), new Quaternion().setFromAxisAngle(Y_AXIS, yaw), colorHex);
  return out;
}

export interface ParkedRowsOptions {
  seed: number;
  /** 総台数。 */
  count: number;
  /** 1列目の始点（地面上）。 */
  start: { x: number; z: number };
  /** 列の伸びる向き（Y 軸まわりの角度、ラジアン。0 で +X 方向）。 */
  rowAngle?: number;
  /** 1列あたりの台数。省略時は全台を1列に並べる。 */
  perRow?: number;
  /** 隣どうしの間隔(m)。 */
  spacing?: number;
  /** 列どうしの間隔(m)。 */
  rowGap?: number;
  /** 地面の高さ。 */
  groundY?: number;
}

/**
 * 駅前の歩道に並んだ駐輪の列。
 * 自転車は列に直交する向きで横に並び、間隔・前後位置・向き・傾きが少しずつばらつく。
 * かご同士が当たらないよう、1台おきに前後へずらす（実際の駐輪場でよく見る並び）。
 */
export function parkedRows(opts: ParkedRowsOptions): BicycleInstances {
  const rng = createRng(opts.seed);
  const n = opts.count;
  const perRow = Math.max(1, opts.perRow ?? n);
  const spacing = opts.spacing ?? 0.6;
  const rowGap = opts.rowGap ?? 2.6;
  const angle = opts.rowAngle ?? 0;
  const groundY = opts.groundY ?? 0;
  const along = new Vector3(Math.cos(angle), 0, -Math.sin(angle));
  // 列に直交する向き（自転車の前方）。列の右手側を向く。
  const facingYaw = angle - Math.PI / 2;
  const forward = new Vector3(Math.cos(facingYaw), 0, -Math.sin(facingYaw));
  const out = allocateInstances(n);
  const p = new Vector3();
  const q = new Quaternion();
  const qa = new Quaternion();
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow);
    const k = i % perRow;
    if (k === 0) offset = 0;
    else offset += spacing * (0.85 + rng() * 0.35);
    const stagger = (k % 2 === 0 ? 1 : -1) * 0.16 + (rng() - 0.5) * 0.08;
    p.set(opts.start.x, groundY, opts.start.z)
      .addScaledVector(along, offset)
      .addScaledVector(forward, stagger - row * rowGap);
    // 向き: 列直交 ± 6°、まれに大きくずれる。傾き: スタンドで立つので ±3°。
    let yaw = facingYaw + (rng() - 0.5) * 0.2;
    if (rng() < 0.08) yaw += (rng() - 0.5) * 0.6;
    const roll = (rng() - 0.5) * 0.1;
    q.setFromAxisAngle(Y_AXIS, yaw).multiply(qa.setFromAxisAngle(X_AXIS, roll));
    writeInstance(out, i, p, q, pickFrameColor(rng()), 0.97 + rng() * 0.03);
  }
  return out;
}

/** 地面上の高さ関数 h(x, z)（m）。山の外では 0 以下を返す。 */
export type HeightFunction = (x: number, z: number) => number;

export interface HeapOptions {
  seed: number;
  count: number;
  height: HeightFunction;
  /** 高さ関数が正になる範囲を含む XZ の矩形。 */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 表面に沿った配置の間隔(m)。台数が山の容量を超えるときは自動で詰める。 */
  spacing?: number;
  /** 層の厚み(m)。 */
  layerThickness?: number;
  /** この深さ(m)より内側の自転車は外から見えないものとして扱う。既定 1.0m。 */
  buriedDepth?: number;
  /** 埋もれた自転車の扱い。'far' は常に遠景用で描く（既定）、'hidden' は描画しない。 */
  buried?: 'far' | 'hidden';
}

/** 表面の法線（中心差分）。 */
function surfaceNormal(h: HeightFunction, x: number, z: number, out: Vector3): Vector3 {
  const e = 0.25;
  const dx = (h(x + e, z) - h(x - e, z)) / (2 * e);
  const dz = (h(x, z + e) - h(x, z - e)) / (2 * e);
  return out.set(-dx, 1, -dz).normalize();
}

/** 指定の間隔と層厚で山に入る台数（格子点の数）。 */
function heapCapacity(h: HeightFunction, b: HeapOptions['bounds'], s: number, t: number): number {
  let total = 0;
  for (let x = b.minX + s / 2; x < b.maxX; x += s) {
    for (let z = b.minZ + s / 2; z < b.maxZ; z += s) {
      const hv = h(x, z);
      if (hv > 0.05) total += 1 + Math.floor(Math.max(0, hv - 0.3) / t);
    }
  }
  return total;
}

/**
 * 高さ関数の表面に沿った山積み。
 * 表面から内側へ層（シェル）を重ね、外側の層から順に埋める。各層ではずらした格子に乱れを加えた位置へ置き、
 * 向きは表面に寝かせたうえで、ヨー・ロール（横倒し）・ピッチをばらつかせる。互いの車輪やかごが重なり、
 * もたれ合って見えるよう、層の間隔は自転車の厚みより詰めてある。
 * 内側の層ほど暗くする（shade）ことで、隙間の奥の陰を表す。
 */
export function heapOnSurface(opts: HeapOptions): BicycleInstances {
  const rng = createRng(opts.seed);
  const h = opts.height;
  const b = opts.bounds;
  let s = opts.spacing ?? 0.8;
  let t = opts.layerThickness ?? 0.4;
  // 台数が容量を超えるなら間隔を詰める
  for (let guard = 0; guard < 60 && heapCapacity(h, b, s, t) < opts.count; guard++) {
    s *= 0.94;
    t *= 0.94;
  }

  const buriedDepth = opts.buriedDepth ?? 1.0;
  const buriedFloor = opts.buried === 'hidden' ? 3 : 2;
  const out = allocateInstances(opts.count);
  const n = new Vector3();
  const p = new Vector3();
  const q = new Quaternion();
  const qa = new Quaternion();
  const qTmp = new Quaternion();
  const center = new Vector3();
  let written = 0;

  for (let layer = 0; written < opts.count && layer < 10000; layer++) {
    const depth = layer * t;
    const ox = rng() * s;
    const oz = rng() * s;
    // この層の候補位置（表面からの深さ depth）
    const cand: number[] = [];
    for (let x = b.minX + ox; x < b.maxX; x += s) {
      for (let z = b.minZ + oz; z < b.maxZ; z += s) {
        const jx = x + (rng() - 0.5) * s * 0.9;
        const jz = z + (rng() - 0.5) * s * 0.9;
        const hv = h(jx, jz);
        if (hv <= 0.05) continue;
        if (layer > 0 && hv - depth < 0.3) continue;
        cand.push(jx, jz);
      }
    }
    if (cand.length === 0) break;
    const m = cand.length / 2;
    // 最後の層は一部だけ使うので、偏らないよう並べ替える
    const order = Array.from({ length: m }, (_, i) => i);
    for (let i = m - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }
    for (const idx of order) {
      if (written >= opts.count) break;
      const x = cand[idx * 2]!;
      const z = cand[idx * 2 + 1]!;
      const hv = h(x, z);
      surfaceNormal(h, x, z, n);
      // 表面上の点（深さ depth だけ鉛直に下げる）。地面より下にはしない。
      const sy = Math.max(0, hv - depth);
      // 向き: 横倒し（ロール 50°〜90°）が多く、ときどき立ち気味・逆さ気味。
      const yaw = rng() * Math.PI * 2;
      const r = rng();
      let roll: number;
      if (r < 0.7) roll = (0.85 + rng() * 0.7) * (rng() < 0.5 ? -1 : 1);
      else if (r < 0.88) roll = (rng() - 0.5) * 1.0;
      else roll = Math.PI + (rng() - 0.5) * 1.2;
      const pitch = (rng() - 0.5) * 1.0;
      // 表面の法線へ寄せる（完全には合わせず、もたれ合う傾きを残す）
      const align = 0.6 + rng() * 0.4;
      qa.setFromUnitVectors(Y_AXIS, n);
      qa.slerp(qTmp.identity(), 1 - align);
      q.copy(qa)
        .multiply(qTmp.setFromAxisAngle(Y_AXIS, yaw))
        .multiply(qTmp.setFromAxisAngle(Z_AXIS, pitch))
        .multiply(qTmp.setFromAxisAngle(X_AXIS, roll));
      // 自転車の中心（原点から高さ 0.5m）を表面の少し上に置く
      center.set(0, 0.5, 0).applyQuaternion(q);
      const lift = 0.15 + rng() * 0.25;
      p.set(x, sy, z).addScaledVector(n, lift).sub(center);
      // 地面にめり込みすぎないよう、中心は 0.25m より上に保つ
      const cy = p.y + center.y;
      if (cy < 0.25) p.y += 0.25 - cy;
      const shade = Math.max(0.3, 1 - depth * 0.35) * (0.85 + rng() * 0.15);
      writeInstance(out, written, p, q, pickFrameColor(rng()), shade);
      if (depth >= buriedDepth) out.lodFloor![written] = buriedFloor;
      written++;
    }
  }
  // 万一埋まりきらなかった分は最後の1台を複製（通常は起きない）
  for (let i = written; i < opts.count && written > 0; i++) {
    out.positions.copyWithin(i * 3, (written - 1) * 3, written * 3);
    out.quaternions.copyWithin(i * 4, (written - 1) * 4, written * 4);
    out.colors.copyWithin(i * 3, (written - 1) * 3, written * 3);
    out.lodFloor![i] = out.lodFloor![written - 1]!;
  }
  return out;
}

/** 円錐に近い山の高さ関数（頂部は丸め、裾はゆるやか）。 */
export function moundHeight(center: { x: number; z: number }, radius: number, peak: number): HeightFunction {
  return (x, z) => {
    const r = Math.hypot(x - center.x, z - center.z) / radius;
    if (r >= 1) return 0;
    // 0..1 の滑らかな断面: 中央は丸く、斜面はほぼ直線、裾は 0 に滑らかに近づく
    const u = 1 - r;
    return peak * (u * u * (3 - 2 * u)) ** 0.75;
  };
}

/** 複数の配置を連結する。 */
export function concatInstances(...parts: BicycleInstances[]): BicycleInstances {
  const total = parts.reduce((a, p) => a + p.count, 0);
  const out = allocateInstances(total);
  let o = 0;
  for (const part of parts) {
    out.positions.set(part.positions.subarray(0, part.count * 3), o * 3);
    out.quaternions.set(part.quaternions.subarray(0, part.count * 4), o * 4);
    out.colors.set(part.colors.subarray(0, part.count * 3), o * 3);
    if (part.shades) out.shades!.set(part.shades.subarray(0, part.count), o);
    if (part.lodFloor) out.lodFloor!.set(part.lodFloor.subarray(0, part.count), o);
    o += part.count;
  }
  return out;
}
