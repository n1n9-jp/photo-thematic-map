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
 * このファイルの後半（`geodeticToEcef`・`ecefToGeodetic`・`ecefToLocalMatrix`）は、
 * 原点で楕円体に接する厳密な ENU（剛体変換）。原点から数 km 以内の ECEF データを
 * そのまま載せる補助で、Y は楕円体高になり、離れると丸みのぶん下がる（2km で約 0.3m）。
 */
import { ORIGIN } from '../config';

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

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const WGS84_B = WGS84_A * Math.sqrt(1 - WGS84_E2);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
const DEG2RAD = Math.PI / 180;

type Triple = [number, number, number];

/** 緯度経度(度)・高さ(m) → ECEF(m)。 */
export function geodeticToEcef(p: LatLonAlt): Triple {
  const lat = p.lat * DEG2RAD;
  const lon = p.lon * DEG2RAD;
  const h = p.alt ?? 0;
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  return [(n + h) * c * Math.cos(lon), (n + h) * c * Math.sin(lon), (n * (1 - WGS84_E2) + h) * s];
}

/** ECEF(m) → 緯度経度(度)・高さ(m)。Bowring の初期値から反復して収束させる。 */
export function ecefToGeodetic(e: Triple): Required<LatLonAlt> {
  const [x, y, z] = e;
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  let lat = Math.atan2(
    z + WGS84_EP2 * WGS84_B * Math.sin(theta) ** 3,
    p - WGS84_E2 * WGS84_A * Math.cos(theta) ** 3,
  );
  let h = 0;
  for (let i = 0; i < 5; i++) {
    const s = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + h)));
  }
  return { lat: lat / DEG2RAD, lon: lon / DEG2RAD, alt: h };
}

/** 原点における ENU の基底ベクトル（ECEF 成分）。 */
function enuBasis(origin: LatLonAlt): { east: Triple; north: Triple; up: Triple } {
  const lat = origin.lat * DEG2RAD;
  const lon = origin.lon * DEG2RAD;
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const sLon = Math.sin(lon);
  const cLon = Math.cos(lon);
  return {
    east: [-sLon, cLon, 0],
    north: [-sLat * cLon, -sLat * sLon, cLat],
    up: [cLat * cLon, cLat * sLon, sLat],
  };
}

const dot = (a: Triple, b: Triple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 緯度 latDeg における子午線曲率半径 M と卯酉線曲率半径 N。 */
function curvatureRadii(latDeg: number): { m: number; n: number } {
  const s = Math.sin(latDeg * DEG2RAD);
  const w2 = 1 - WGS84_E2 * s * s;
  const w = Math.sqrt(w2);
  return { n: WGS84_A / w, m: (WGS84_A * (1 - WGS84_E2)) / (w2 * w) };
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
 * 原点の厳密な ENU 行列（ECEF → X=東・Y=上・Z=南）。行優先の 4x4。
 * 原点から数 km 以内の ECEF データを載せる補助。Y は楕円体高（`origin.alt` を楕円体高とみなす）で、
 * 離れると丸みのぶん下がる。平らな地図（`latLonToLocal`）とは、原点から 2km で水平 約0.25m・高さ 約0.3m、3km で水平 約0.6m ずれる。
 *
 * 返り値は行優先（row-major）の配列なので、three.js では
 * `new Matrix4().set(...ecefToLocalMatrix())` で使う（`Matrix4.set` は行優先で受け取る）。
 * `Matrix4.fromArray` は列優先（column-major）で読むため、そのまま渡すと転置した行列になり使えない。
 */
export function ecefToLocalMatrix(origin: LatLonAlt = ORIGIN): number[] {
  const o = geodeticToEcef(origin);
  const { east, north, up } = enuBasis(origin);
  const south: Triple = [-north[0], -north[1], -north[2]];
  return [
    east[0], east[1], east[2], -dot(east, o),
    up[0], up[1], up[2], -dot(up, o),
    south[0], south[1], south[2], -dot(south, o),
    0, 0, 0, 1,
  ];
}
