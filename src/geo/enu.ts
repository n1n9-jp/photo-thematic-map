/**
 * ローカル ENU 座標 ⇄ 緯度経度の変換。
 *
 * three.js 側の規約: X=東, Y=上, Z=南（-Z が北）, 1単位=1m。
 * ENU（East, North, Up）との対応: x = east, y = up, z = -north。
 *
 * WGS84 の ECEF（地球中心座標）を経由する厳密な変換で、原点 ORIGIN で
 * 地球楕円体に接する平面を基準にする。PLATEAU の 3D Tiles（ECEF 座標）を
 * 同じ原点の ENU 行列でシーンに載せたとき、この関数の結果と位置が一致する。
 *
 * 接平面なので、原点から離れると地表は Y の負の方向へ下がる
 * （10km で約 8m、20km で約 31m）。同じ高さの点でも y は一定にならない。
 */
import { ORIGIN } from '../config';

export interface LatLonAlt {
  lat: number;
  lon: number;
  /** 高さ(m)。原点の alt と同じ基準で表す。省略時は 0。 */
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

/** 緯度経度(度)・高さ(m) → three.js ローカル座標(m)。 */
export function latLonToLocal(p: LatLonAlt, origin: LatLonAlt = ORIGIN): Vec3 {
  const o = geodeticToEcef(origin);
  const q = geodeticToEcef(p);
  const d: Triple = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
  const { east, north, up } = enuBasis(origin);
  return { x: dot(d, east), y: dot(d, up), z: -dot(d, north) };
}

/** three.js ローカル座標(m) → 緯度経度(度)・高さ(m)。latLonToLocal の逆変換。 */
export function localToLatLon(v: Vec3, origin: LatLonAlt = ORIGIN): Required<LatLonAlt> {
  const o = geodeticToEcef(origin);
  const { east, north, up } = enuBasis(origin);
  const e = v.x;
  const n = -v.z;
  const u = v.y;
  return ecefToGeodetic([
    o[0] + e * east[0] + n * north[0] + u * up[0],
    o[1] + e * east[1] + n * north[1] + u * up[1],
    o[2] + e * east[2] + n * north[2] + u * up[2],
  ]);
}

/**
 * 原点の ENU 行列（ECEF → three.js ローカル座標）。行優先の 4x4。
 * 3D Tiles など ECEF 座標のデータをシーンに載せるときに使う。
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
