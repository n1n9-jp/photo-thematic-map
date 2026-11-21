/**
 * 海陸マスク（`public/data/basemap/landmask.png`）の範囲。
 *
 * 国土地理院の標高タイル（dem_png）の無効値（海）から `scripts/data/build-landmask.ts` が作る。
 * ズーム `LANDMASK.z` の XYZ タイル `x0..x0+tilesX-1`・`y0..y0+tilesY-1` を並べた範囲で、1画素がタイル1画素（約 250m）に当たる。
 * 画像は 1 が海、0 が陸。
 */
export const LANDMASK = {
  z: 9,
  x0: 453,
  y0: 200,
  tilesX: 4,
  tilesY: 4,
  /** 1タイルの画素数。 */
  tileSize: 256,
  /** `public/` からの相対パス。 */
  path: 'data/basemap/landmask.png',
} as const;
