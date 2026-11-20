/**
 * カメラのキーフレーム補間（描画に依存しない純粋ロジック）。
 *
 * 数十 m の接写から数十 km の俯瞰までを自然に引くため、距離は対数空間で補間する。
 * 注視点は線形、方位角は最短回りの線形、仰角は線形に補間する。
 */
import { ORIGIN } from '../config';
import { latLonToLocal, type LatLonAlt, type Vec3 } from '../geo/enu';
import type { StoryCameraKeyframe } from './types';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

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

/** 緯度経度のキーフレームをローカル座標の姿勢にする。 */
export function keyframeToPose(k: StoryCameraKeyframe, origin?: LatLonAlt): CameraPose {
  return {
    target: latLonToLocal(k.target, origin ?? ORIGIN),
    distance: k.distance,
    azimuthDeg: k.azimuthDeg,
    elevationDeg: k.elevationDeg,
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
  return heightM / Math.sin(elevationDeg * DEG2RAD);
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

/** 2つの姿勢の補間。t=0 で a、t=1 で b に厳密に一致する。距離は対数空間で補間する。 */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return {
    target: {
      x: a.target.x + (b.target.x - a.target.x) * t,
      y: a.target.y + (b.target.y - a.target.y) * t,
      z: a.target.z + (b.target.z - a.target.z) * t,
    },
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * t),
    azimuthDeg: normalizeDeg(a.azimuthDeg + shortestDeltaDeg(a.azimuthDeg, b.azimuthDeg) * t),
    elevationDeg: a.elevationDeg + (b.elevationDeg - a.elevationDeg) * t,
  };
}

export interface SamplePathOptions {
  /** 各キーフレームで止まる割合(0〜1)。既定 `DEFAULT_HOLD`。 */
  hold?: number;
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

  const hold = options.hold ?? DEFAULT_HOLD;
  const ease = options.ease ?? smoothstep;
  const last = poses.length - 1;
  const s = Math.min(Math.max(position, 0), last);
  const i = Math.min(Math.floor(s), last - 1);
  const f = s - i;
  const t = hold >= 1 ? (f >= 1 ? 1 : 0) : clamp01((f - hold) / (1 - hold));
  const a = poses[i];
  const b = poses[i + 1];
  if (!a || !b) throw new Error('samplePath: 内部エラー');
  return lerpPose(a, b, ease(t));
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
