/**
 * XYZ（Web メルカトル）タイルの計算と、国土地理院 標高タイル（PNG）の値の復号。
 */

const DEG2RAD = Math.PI / 180;

/** 経度(度) → ズーム z のタイル X（小数を含む）。 */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** 緯度(度) → ズーム z のタイル Y（小数を含む）。 */
export function latToTileY(lat: number, z: number): number {
  const phi = lat * DEG2RAD;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** z;
}

/** ズーム z のタイル X（小数可） → 経度(度)。 */
export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

/** ズーム z のタイル Y（小数可） → 緯度(度)。 */
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return Math.atan(Math.sinh(n)) / DEG2RAD;
}

export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** タイル (z, x, y) の緯度経度範囲。 */
export function tileBounds(z: number, x: number, y: number): TileBounds {
  return {
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

/**
 * 国土地理院 標高タイル（PNG 形式）の 1 画素を標高(m)に復号する。
 * x = R·2^16 + G·2^8 + B。x < 2^23 なら h = 0.01x、x > 2^23 なら h = 0.01(x − 2^24)、
 * x = 2^23 は無効値（null）。
 * 仕様: https://maps.gsi.go.jp/development/demtile.html
 */
export function decodeGsiDemPixel(r: number, g: number, b: number): number | null {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;
  return x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
}
