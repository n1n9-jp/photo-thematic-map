/**
 * WGS84 の楕円体座標（緯度・経度・楕円体高）と ECEF 座標の相互変換。
 *
 * 3D Tiles（PLATEAU）のジオメトリは ECEF・楕円体高で格納されているため、
 * ローカル座標（`enu.ts`）へ載せ替えるときの中間表現として使う。
 */

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const WGS84_B = WGS84_A * Math.sqrt(1 - WGS84_E2);
const EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
const DEG2RAD = Math.PI / 180;

export interface Ecef {
  x: number;
  y: number;
  z: number;
}

export interface Geodetic {
  /** 緯度(度) */
  lat: number;
  /** 経度(度) */
  lon: number;
  /** 楕円体高(m) */
  height: number;
}

/** 緯度経度(度)・楕円体高(m) → ECEF(m)。 */
export function geodeticToEcef(lat: number, lon: number, height: number): Ecef {
  const phi = lat * DEG2RAD;
  const lam = lon * DEG2RAD;
  const s = Math.sin(phi);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  return {
    x: (n + height) * Math.cos(phi) * Math.cos(lam),
    y: (n + height) * Math.cos(phi) * Math.sin(lam),
    z: (n * (1 - WGS84_E2) + height) * s,
  };
}

/** ECEF(m) → 緯度経度(度)・楕円体高(m)。Bowring の式（地表付近で mm 未満の誤差）。 */
export function ecefToGeodetic(p: Ecef): Geodetic {
  const r = Math.hypot(p.x, p.y);
  const theta = Math.atan2(p.z * WGS84_A, r * WGS84_B);
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const phi = Math.atan2(p.z + EP2 * WGS84_B * st * st * st, r - WGS84_E2 * WGS84_A * ct * ct * ct);
  const lam = Math.atan2(p.y, p.x);
  const s = Math.sin(phi);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  const height = r / Math.cos(phi) - n;
  return { lat: phi / DEG2RAD, lon: lam / DEG2RAD, height };
}

/** 緯度経度(度)における ENU 基底（東・北・上の単位ベクトル、ECEF 成分）。 */
export function enuBasis(lat: number, lon: number): { east: Ecef; north: Ecef; up: Ecef } {
  const phi = lat * DEG2RAD;
  const lam = lon * DEG2RAD;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  return {
    east: { x: -sl, y: cl, z: 0 },
    north: { x: -sp * cl, y: -sp * sl, z: cp },
    up: { x: cp * cl, y: cp * sl, z: sp },
  };
}
