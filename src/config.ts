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
