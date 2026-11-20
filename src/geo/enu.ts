/**
 * 緯度経度 ⇄ ローカル座標の変換。
 *
 * three.js 側の規約: X=東, Y=上, Z=南（-Z が北）, 1単位=1m。
 *
 * ローカル座標は「平らな地図」:
 * - 水平（X・Z）は、原点の曲率半径を使う局所近似（等距離円筒）。
 * - 高さ（Y）は標高そのもの（`alt - ORIGIN.alt`）。地球の丸みは持たない。
 * PLATEAU の建物（`src/scene/plateau/buildings.ts`）は、タイルごとにこの変換の位置へ置き直す。
 * 地面・自転車・カメラなど、緯度経度から位置を決めるものはすべてこの関数を通す。
 *
 * 水平の近似は、原点から南北に離れるほど東西の縮尺がずれる（南北 20km で約 0.2%）。
 *
 * このファイルの後半（`geodeticToEcef`・`ecefToGeodetic`・`ecefToTangentMatrix`）は、
 * 原点で楕円体に接する厳密な ENU（剛体変換）。原点から数 km 以内の ECEF データを
 * そのまま載せる補助で、Y は楕円体高になり、離れると丸みのぶん下がる（2km で約 0.3m）。
 * 楕円体の計算そのものは `ecef.ts` に一本化している。
 */
import { ORIGIN } from '../config';
import {
  curvatureRadii,
  ecefToGeodetic as ecefToGeodeticXyz,
  enuBasis,
  geodeticToEcef as geodeticToEcefXyz,
} from './ecef';
import type { Ecef } from './ecef';

export interface LatLonAlt {
  lat: number;
  lon: number;
  /** 標高(m)。省略時は 0。（`geodeticToEcef` に渡すときは楕円体高として扱われる） */
  alt?: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const DEG2RAD = Math.PI / 180;

type Triple = [number, number, number];

/** 緯度経度(度)・高さ(m) → ECEF(m)。`ecef.ts` の `geodeticToEcef` を配列で返す形にしたもの。 */
export function geodeticToEcef(p: LatLonAlt): Triple {
  const e = geodeticToEcefXyz(p.lat, p.lon, p.alt ?? 0);
  return [e.x, e.y, e.z];
}

/** ECEF(m) → 緯度経度(度)・高さ(m)。`ecef.ts` の `ecefToGeodetic` を配列で受け取る形にしたもの。 */
export function ecefToGeodetic(e: Triple): Required<LatLonAlt> {
  const g = ecefToGeodeticXyz({ x: e[0], y: e[1], z: e[2] });
  return { lat: g.lat, lon: g.lon, alt: g.height };
}

/** 緯度経度(度)・標高(m) → three.js ローカル座標(m)。平らな地図（Y は標高）。 */
export function latLonToLocal(p: LatLonAlt, origin: LatLonAlt = ORIGIN): Vec3 {
  const { m, n } = curvatureRadii(origin.lat);
  const east = (p.lon - origin.lon) * DEG2RAD * n * Math.cos(origin.lat * DEG2RAD);
  const north = (p.lat - origin.lat) * DEG2RAD * m;
  const up = (p.alt ?? 0) - (origin.alt ?? 0);
  return { x: east, y: up, z: -north };
}

/** three.js ローカル座標(m) → 緯度経度(度)・標高(m)。latLonToLocal の逆変換。 */
export function localToLatLon(v: Vec3, origin: LatLonAlt = ORIGIN): Required<LatLonAlt> {
  const { m, n } = curvatureRadii(origin.lat);
  const lat = origin.lat + -v.z / (m * DEG2RAD);
  const lon = origin.lon + v.x / (n * Math.cos(origin.lat * DEG2RAD) * DEG2RAD);
  const alt = (origin.alt ?? 0) + v.y;
  return { lat, lon, alt };
}

/**
 * latLonToLocal の、緯度 1 度・経度 1 度あたりのローカル座標の変化(m)。
 * 平らな地図の縮尺は原点の曲率半径で決まるので、場所によらず一定。
 */
export function localMetersPerDegree(origin: LatLonAlt = ORIGIN): { east: number; north: number } {
  const { m, n } = curvatureRadii(origin.lat);
  return { east: DEG2RAD * n * Math.cos(origin.lat * DEG2RAD), north: DEG2RAD * m };
}

/**
 * 原点の厳密な ENU 行列（ECEF → X=東・Y=上・Z=南）。行優先の 4x4。
 * 原点から数 km 以内の ECEF データを載せる補助。Y は楕円体高（`origin.alt` を楕円体高とみなす）で、
 * 離れると丸みのぶん下がる。平らな地図（`latLonToLocal`）とは、原点から 2km で水平 約0.25m・高さ 約0.3m、3km で水平 約0.6m ずれる。
 *
 * 返り値は行優先（row-major）の配列なので、three.js では
 * `new Matrix4().set(...ecefToTangentMatrix())` で使う（`Matrix4.set` は行優先で受け取る）。
 * `Matrix4.fromArray` は列優先（column-major）で読むため、そのまま渡すと転置した行列になり使えない。
 *
 * PLATEAU の建物をタイルごとに平らな地図へ置く行列は、`src/scene/plateau/buildings.ts` の
 * `ecefToLocalMatrix`（タイル中心で平らな地図に合わせる。これとは別物）。
 */
export function ecefToTangentMatrix(origin: LatLonAlt = ORIGIN): number[] {
  const o = geodeticToEcefXyz(origin.lat, origin.lon, origin.alt ?? 0);
  const { east, north, up } = enuBasis(origin.lat, origin.lon);
  const dot = (a: Ecef): number => a.x * o.x + a.y * o.y + a.z * o.z;
  // prettier-ignore
  return [
    east.x, east.y, east.z, -dot(east),
    up.x, up.y, up.z, -dot(up),
    -north.x, -north.y, -north.z, dot(north),
    0, 0, 0, 1,
  ];
}

/**
 * @deprecated `ecefToTangentMatrix` に改名した（`buildings.ts` の `ecefToLocalMatrix` と紛らわしいため）。
 * 移行が済むまでの別名。
 */
export const ecefToLocalMatrix = ecefToTangentMatrix;
