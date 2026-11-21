/**
 * 本文カードが占める範囲と、3D の主役を置く範囲の計算（描画に依存しない純粋ロジック）。
 *
 * - `side`: 画面の左に細い列でカードが流れる（PC 幅・横向き）。主役は、列を除いた右側の範囲の中央に置く。
 * - `bottom`: 画面の下寄りにカードが並ぶ（スマートフォンの縦向き）。主役は、カードが届かない上側の範囲の中央に置く。
 *
 * カメラの向きは変えず、画面上の投影の中心だけをずらす。ずらす量は、画面の幅・高さに対する割合（-0.5〜0.5）で表す。
 */

export type StoryLayout = 'side' | 'bottom';

/** 画面（canvas）の左上を原点とする長方形(CSS px)。 */
export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FreeRegionInput {
  layout: StoryLayout;
  /** canvas の大きさ(CSS px)。 */
  width: number;
  height: number;
  /** いま見えている範囲の高さ(CSS px)。モバイルのアドレスバーが出ている間は `height` より小さい。 */
  visibleHeight: number;
  /** `side`: カードの列の右端の x。 */
  columnRight: number;
  /** `bottom`: すべてのカードのうち、いちばん高いところにあるカードの上端の y。 */
  coverTop: number;
  /** カードと主役の範囲のあいだに空ける余白(px)。既定 16。 */
  gap?: number;
}

/** `side` で、主役の範囲が画面の幅のこの割合より狭くならないようにする（列が極端に広い画面でも主役を残す）。 */
const MIN_SIDE_FREE_FRACTION = 0.4;
/** `bottom` で、主役の範囲が見えている高さのこの割合より低くならないようにする。 */
const MIN_BOTTOM_FREE_FRACTION = 0.25;

/** カードに覆われていない範囲。 */
export function freeRegionFor(input: FreeRegionInput): Region {
  const { layout, width, height, visibleHeight, columnRight, coverTop } = input;
  const gap = input.gap ?? 16;
  const visible = Math.min(Math.max(visibleHeight, 1), height);
  if (layout === 'side') {
    const left = Math.min(Math.max(columnRight + gap, 0), width * (1 - MIN_SIDE_FREE_FRACTION));
    return { left, top: 0, right: width, bottom: visible };
  }
  const bottom = Math.min(Math.max(coverTop - gap, visible * MIN_BOTTOM_FREE_FRACTION), visible);
  return { left: 0, top: 0, right: width, bottom };
}

/**
 * 画面の中心にある注視点を `region` の中心へ動かすための、投影の中心のずらし量（画面の幅・高さに対する割合）。
 * x が正なら右へ、y が正なら下へずれる。
 */
export function viewShiftFor(region: Region, width: number, height: number): { x: number; y: number } {
  const cx = (region.left + region.right) / 2;
  const cy = (region.top + region.bottom) / 2;
  return { x: (cx - width / 2) / width, y: (cy - height / 2) / height };
}
