/** 座標原点（東京駅）。ENU 変換の基準点。 */
export const ORIGIN = {
  lat: 35.68124,
  lon: 139.76712,
  /** 楕円体高ではなく標高(m)。ローカル Y=0 に対応する。 */
  alt: 0,
} as const;

/** 地面の一辺の長さ(m)。 */
export const GROUND_SIZE_M = 1000;

/** 原点に置く基準箱の一辺の長さ(m)。 */
export const REFERENCE_BOX_SIZE_M = 10;

/**
 * 原点付近のジオイド高(m)（楕円体高 − 標高）。
 * PLATEAU の 3D Tiles は楕円体高で、ローカル Y は標高なので、建物はこの値だけ下げて置く。
 * 実測: 東京駅周辺 36.66m、渋谷駅周辺 36.77m（タイルの高さ範囲と建物属性 _zmin の差）。
 * 23区内の差は 0.1m 程度なので定数で扱う。
 */
export const GEOID_HEIGHT_M = 36.7;

/**
 * PLATEAU 航空写真（PLATEAU-Ortho）の XYZ タイル。最大ズーム 19、最小ズーム 10。
 * 提供元の文書（https://docs.plateauview.mlit.go.jp/datasets/ortho/）が示すホスト。
 * 以前の api.plateauview.mlit.go.jp は要求のたびにこのホストへ 307 で転送する。
 */
export const PLATEAU_ORTHO_URL = 'https://tile.plateauview.mlit.go.jp/tiles/plateau-ortho-2024/{z}/{x}/{y}.png';
export const PLATEAU_ORTHO_MAX_ZOOM = 19;

/** 国土地理院 標高タイル（PNG）。5m メッシュ（ズーム15のみ）と 10m メッシュ（ズーム0〜14）。 */
export const GSI_DEM5A_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png';
export const GSI_DEM5A_ZOOM = 15;
export const GSI_DEM10_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
export const GSI_DEM10_MAX_ZOOM = 14;
