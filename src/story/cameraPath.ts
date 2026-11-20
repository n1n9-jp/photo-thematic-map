/**
 * カメラのキーフレーム補間（描画に依存しない純粋ロジック）。
 *
 * 注視点と距離は van Wijk–Nuij の「最適なズームとパン」（Smooth and efficient zooming and panning, 2003）で補間する。
 * 遠くへ移るときは「引いてから動き、動いてから寄る」経路になり、画面上の見かけの移動の速さ
 * （注視点の移動量 ÷ その時点の距離）が経路全体で一定になる。注視点がほぼ同じなら距離の対数補間と一致する。
 * 方位角は最短回りの線形、仰角は線形に補間する。
 */
import { ORIGIN } from '../config';
import { latLonToLocal, type Vec3 } from '../geo/enu';
import type { StoryCameraKeyframe } from './types';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** 仰角の上限(度)。真上(90°)では方位が決まらず、カメラの向きが不安定になるため。 */
export const MAX_ELEVATION_DEG = 89;

/** van Wijk–Nuij の ρ。ズームとパンの釣り合い。論文の推奨値 √2。 */
export const ZOOM_PAN_RHO = Math.SQRT2;

/** ローカル座標で表したカメラ姿勢。 */
export interface CameraPose {
  /** 注視点（three.js ローカル座標, m）。 */
  target: Vec3;
  /** 注視点からカメラまでの距離(m)。 */
  distance: number;
  /** カメラが向いている方位(度)。北=0、東=90。 */
  azimuthDeg: number;
  /** 仰角(度)。 */
  elevationDeg: number;
}

/** 地表のローカル Y(m) を、ローカル座標の x, z から返す関数。 */
export type GroundHeightAt = (x: number, z: number) => number;

/** 地点の地表のローカル Y(m) を、緯度経度(度)から返す関数。 */
export type GroundYAt = (lat: number, lon: number) => number;

/** 既定の地表: `latLonToLocal` で高さ 0 として求めた Y（接平面なので原点から離れると下がる）。 */
export function defaultGroundY(lat: number, lon: number): number {
  return latLonToLocal({ lat, lon, alt: 0 }).y;
}

/** キーフレームごとの「そのまま止まる」区間の割合（段階内の進捗）。残りでつぎのキーフレームへ移る。 */
export const DEFAULT_HOLD = 0.4;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 0〜1 を滑らかに 0〜1 へ（両端で傾き 0）。 */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function clampElevation(deg: number): number {
  return Math.min(deg, MAX_ELEVATION_DEG);
}

/**
 * 緯度経度のキーフレームをローカル座標の姿勢にする。
 * 注視点の Y は `groundY(lat, lon) + target.alt`（alt は地表からの高さ）。仰角は `MAX_ELEVATION_DEG` までに丸める。
 */
export function keyframeToPose(k: StoryCameraKeyframe, groundY: GroundYAt = defaultGroundY): CameraPose {
  const ground = latLonToLocal({ lat: k.target.lat, lon: k.target.lon, alt: 0 }, ORIGIN);
  return {
    target: { x: ground.x, y: groundY(k.target.lat, k.target.lon) + (k.target.alt ?? 0), z: ground.z },
    distance: k.distance,
    azimuthDeg: k.azimuthDeg,
    elevationDeg: clampElevation(k.elevationDeg),
  };
}

/** 姿勢からカメラ位置（ローカル座標）を求める。 */
export function poseToCameraPosition(p: CameraPose): Vec3 {
  const az = p.azimuthDeg * DEG2RAD;
  const el = p.elevationDeg * DEG2RAD;
  const horizontal = p.distance * Math.cos(el);
  // カメラは向いている方位の反対側にいる。east = sin(az), north = cos(az), z = -north
  return {
    x: p.target.x - Math.sin(az) * horizontal,
    y: p.target.y + Math.sin(el) * p.distance,
    z: p.target.z + Math.cos(az) * horizontal,
  };
}

/** カメラ位置と注視点から姿勢を求める（`poseToCameraPosition` の逆）。 */
export function poseFromCamera(position: Vec3, target: Vec3): CameraPose {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const horizontal = Math.hypot(dx, dz);
  const distance = Math.hypot(horizontal, dy);
  // 視線の方位: east = dx, north = -dz
  const azimuthDeg = horizontal > 1e-9 ? normalizeDeg(Math.atan2(dx, -dz) * RAD2DEG) : 0;
  const elevationDeg = distance > 1e-9 ? Math.atan2(-dy, horizontal) * RAD2DEG : 0;
  return { target: { ...target }, distance, azimuthDeg, elevationDeg };
}

/** 高さ heightM(m) の位置から見下ろす仰角 elevationDeg のときの、注視点からの距離。 */
export function distanceForHeight(heightM: number, elevationDeg: number): number {
  return heightM / Math.sin(clampElevation(elevationDeg) * DEG2RAD);
}

/** 度を [0, 360) に正規化する。 */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** a から b への最短回りの角度差(度)。(-180, 180]。 */
function shortestDeltaDeg(a: number, b: number): number {
  const d = normalizeDeg(b - a);
  return d > 180 ? d - 360 : d;
}

/**
 * 注視点と距離の van Wijk–Nuij 補間。t(0〜1) に対して、注視点の a→b の割合 u(0〜1) と距離 w を返す。
 * 経路の長さ S に対して等速で進むので、t あたりの「注視点の移動量 ÷ 距離」は経路全体でほぼ一定（最大で ρ·S 程度）。
 */
export function zoomPan(
  w0: number,
  w1: number,
  panLength: number,
  rho: number = ZOOM_PAN_RHO,
): { S: number; at(t: number): { u: number; w: number } } {
  const rho2 = rho * rho;
  const rho4 = rho2 * rho2;
  // 注視点がほとんど動かないときは、距離の対数補間（純粋なズーム）。
  if (panLength < 1e-6 * Math.min(w0, w1)) {
    const S = Math.abs(Math.log(w1 / w0)) / rho;
    return {
      S,
      at: (t) => ({ u: t, w: w0 * Math.exp(Math.log(w1 / w0) * t) }),
    };
  }
  const d = panLength;
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d * d) / (2 * w0 * rho2 * d);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d * d) / (2 * w1 * rho2 * d);
  // r = asinh(-b) を数値的に安定な形で。
  const r0 = -Math.asinh(b0);
  const r1 = -Math.asinh(b1);
  const S = (r1 - r0) / rho;
  const coshR0 = Math.cosh(r0);
  const sinhR0 = Math.sinh(r0);
  return {
    S,
    at(t) {
      const s = t * S;
      const u = (w0 / (rho2 * d)) * (coshR0 * Math.tanh(rho * s + r0) - sinhR0);
      const w = (w0 * coshR0) / Math.cosh(rho * s + r0);
      return { u, w };
    },
  };
}

/**
 * 2つの姿勢の補間。t=0 で a、t=1 で b に厳密に一致する。
 * 注視点と距離は `zoomPan`（遠くへ移るときは引いてから動き、動いてから寄る）、角度は線形。
 */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const dx = b.target.x - a.target.x;
  const dy = b.target.y - a.target.y;
  const dz = b.target.z - a.target.z;
  const { u, w } = zoomPan(a.distance, b.distance, Math.hypot(dx, dy, dz)).at(t);
  return {
    target: { x: a.target.x + dx * u, y: a.target.y + dy * u, z: a.target.z + dz * u },
    distance: w,
    azimuthDeg: normalizeDeg(a.azimuthDeg + shortestDeltaDeg(a.azimuthDeg, b.azimuthDeg) * t),
    elevationDeg: clampElevation(a.elevationDeg + (b.elevationDeg - a.elevationDeg) * t),
  };
}

export interface SamplePathOptions {
  /**
   * 各キーフレームで止まる割合(0〜1)。配列なら区間 [i, i+1] に `hold[i]` を使う（足りない分は既定値）。
   * 既定 `DEFAULT_HOLD`。
   */
  hold?: number | readonly number[];
  /** 区間内の進捗(0〜1)に掛ける緩急。既定 `smoothstep`。 */
  ease?: (t: number) => number;
}

/**
 * 連続位置 position（0〜N-1）でのカメラ姿勢。
 * 整数 i ちょうどでキーフレーム i に一致する。区間 [i, i+1] の前半（hold）は i に留まり、
 * 残りで i+1 へ移る。範囲外は端のキーフレームに丸める。
 */
export function samplePath(
  poses: readonly CameraPose[],
  position: number,
  options: SamplePathOptions = {},
): CameraPose {
  const first = poses[0];
  if (!first) throw new Error('samplePath: poses が空です');
  if (poses.length === 1) return first;

  const ease = options.ease ?? smoothstep;
  const last = poses.length - 1;
  const s = Math.min(Math.max(position, 0), last);
  const i = Math.min(Math.floor(s), last - 1);
  const f = s - i;
  const holdOpt = options.hold;
  const hold = typeof holdOpt === 'number' ? holdOpt : (holdOpt?.[i] ?? DEFAULT_HOLD);
  const t = hold >= 1 ? (f >= 1 ? 1 : 0) : clamp01((f - hold) / (1 - hold));
  const a = poses[i];
  const b = poses[i + 1];
  if (!a || !b) throw new Error('samplePath: 内部エラー');
  return lerpPose(a, b, ease(t));
}

/**
 * カメラが地表から minClearance(m) 以上離れるように、仰角を上げて（足りなければ距離を伸ばして）持ち上げる。
 * 注視点と方位は変えない。仰角は `MAX_ELEVATION_DEG` まで。
 */
export function liftAboveGround(pose: CameraPose, groundAt: GroundHeightAt, minClearance: number): CameraPose {
  let p = pose;
  // 仰角を変えるとカメラの水平位置も動き、そこの地表の高さが変わるので数回繰り返す。
  for (let n = 0; n < 3; n++) {
    const cam = poseToCameraPosition(p);
    const floor = groundAt(cam.x, cam.z) + minClearance;
    if (cam.y >= floor - 1e-9) return p;
    const need = floor - p.target.y;
    const maxSin = Math.sin(MAX_ELEVATION_DEG * DEG2RAD);
    if (need <= p.distance * maxSin) {
      p = { ...p, elevationDeg: Math.asin(need / p.distance) * RAD2DEG };
    } else {
      p = { ...p, elevationDeg: MAX_ELEVATION_DEG, distance: need / maxSin };
    }
  }
  return p;
}

/**
 * 注視点までの距離と地表からの高さに合わせた near / far(m)。
 * near は近い方（距離・高さ）の 5%（最小 0.1m）、far は地平線までの距離と注視点の距離の4倍の大きい方（2km〜400km）。
 */
export function clipPlanesFor(distance: number, heightAboveGround: number): { near: number; far: number } {
  const h = Math.max(heightAboveGround, 0.5);
  const near = Math.max(0.1, 0.05 * Math.min(distance, h));
  const horizon = Math.sqrt(2 * 6_371_000 * h + h * h);
  const far = Math.min(Math.max(horizon + distance, distance * 4, 2_000), 400_000);
  return { near, far: Math.max(far, near * 10) };
}

/**
 * 2つの姿勢の差を、スケールに依存しない1つの数値で表す（収束判定用）。
 * 距離の対数差 + 注視点のずれ/距離 + 角度差(rad)。
 */
export function poseDelta(a: CameraPose, b: CameraPose): number {
  const dLogDist = Math.abs(Math.log(a.distance) - Math.log(b.distance));
  const dTarget =
    Math.hypot(a.target.x - b.target.x, a.target.y - b.target.y, a.target.z - b.target.z) /
    Math.max(b.distance, 1e-6);
  const dAngle =
    (Math.abs(shortestDeltaDeg(a.azimuthDeg, b.azimuthDeg)) +
      Math.abs(a.elevationDeg - b.elevationDeg)) *
    DEG2RAD;
  return dLogDist + dTarget + dAngle;
}
