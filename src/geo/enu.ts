/**
 * ローカル ENU 座標 ⇄ 緯度経度の変換。
 *
 * three.js 側の規約: X=東, Y=上, Z=南（-Z が北）, 1単位=1m。
 * ENU（East, North, Up）との対応: x = east, y = up, z = -north。
 *
 * 変換は WGS84 の局所曲率半径による等距離円筒近似。
 * 原点から数十 km 以内で cm 級の往復一致が得られる（往復は厳密な逆関数）。
 */
import { ORIGIN } from '../config';

export interface LatLonAlt {
  lat: number;
  lon: number;
  /** 標高(m)。省略時は 0。 */
  alt?: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const DEG2RAD = Math.PI / 180;

/** 緯度 latDeg における子午線曲率半径 M と卯酉線曲率半径 N。 */
function curvatureRadii(latDeg: number): { m: number; n: number } {
  const s = Math.sin(latDeg * DEG2RAD);
  const w2 = 1 - WGS84_E2 * s * s;
  const w = Math.sqrt(w2);
  return { n: WGS84_A / w, m: (WGS84_A * (1 - WGS84_E2)) / (w2 * w) };
}

/** 緯度経度(度)・標高(m) → three.js ローカル座標(m)。 */
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
