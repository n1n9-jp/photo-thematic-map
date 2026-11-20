import type { LatLonAlt } from '../geo/enu';

/**
 * カメラのキーフレーム。「注視点から離れた位置に立って注視点を見る」形で表す。
 *
 * - target: 注視点の緯度経度(度)と高さ。`alt` は標高(m)で、ローカル Y は `alt - ORIGIN.alt`。
 * - distance: 注視点からカメラまでの距離(m)。数十 m 〜 数十 km。
 * - azimuthDeg: カメラが向いている方位(度)。北=0、東=90、時計回り。
 * - elevationDeg: 仰角(度)。0 で水平、90 で真下を見下ろす。
 */
export interface StoryCameraKeyframe {
  target: LatLonAlt;
  distance: number;
  azimuthDeg: number;
  elevationDeg: number;
}

/** 大きく表示する数値。段階内の進捗に合わせて 0 から `value` まで数え上がる。 */
export interface StoryStat {
  value: number;
  /** 数値の右に添える単位（例: 台）。 */
  unit?: string;
  /** 数値の下に添える説明。 */
  label?: string;
}

export interface StoryText {
  heading: string;
  paragraphs: readonly string[];
  stat?: StoryStat;
}

/** 段階内の進捗コールバックに渡す情報。 */
export interface StoryProgressInfo {
  /** 段階の番号（0 始まり）。 */
  index: number;
  stage: StoryStage;
}

export interface StoryStage {
  /** 段階を識別する文字列。DOM の `data-stage-id` にも使う。 */
  id: string;
  text: StoryText;
  /** この段階の本文を読んでいる間のカメラ位置。 */
  camera: StoryCameraKeyframe;
  /** true なら、この段階に入ったら OrbitControls を有効にして自由に動かせる。 */
  freeOrbit?: boolean;
  /**
   * 段階内の進捗(0〜1)を受け取る。この段階の区間にいる間、進捗が変わるたびに呼ばれる。
   * 段階を離れるときは、進んで離れたなら 1、戻って離れたなら 0 で最後に1回呼ばれる。
   */
  onProgress?: (progress: number, info: StoryProgressInfo) => void;
}

/** スクロール位置から決まる語りの現在状態。 */
export interface StoryState {
  /** 現在の段階の番号（0 始まり）。 */
  stage: number;
  /** 現在の段階内の進捗(0〜1)。 */
  progress: number;
  /** 連続位置。`stage + progress`。整数ちょうどでその番号のキーフレームに一致する。 */
  position: number;
}
