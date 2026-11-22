import type { LatLonAlt } from '../geo/enu';

/**
 * カメラのキーフレーム。「注視点から離れた位置に立って注視点を見る」形で表す。
 *
 * - target: 注視点の緯度経度(度)と高さ。`alt` は「その地点の地表からの高さ(m)」（省略時 0）。
 *   注視点のローカル Y は `groundY(lat, lon) + alt`。`groundY` は `createStory` のオプションで渡す地表のローカル Y で、
 *   既定は `latLonToLocal` で高さ 0 として求めた Y（PLATEAU の地表の高さが確定したら差し替える）。
 * - distance: 注視点からカメラまでの距離(m)。数十 m 〜 数十 km。
 * - azimuthDeg: カメラが向いている方位(度)。北=0、東=90、時計回り。
 * - elevationDeg: 仰角(度)。0 で水平、90 で真下を見下ろす。89 を上限に丸める。
 */
export interface StoryCameraKeyframe {
  target: LatLonAlt;
  distance: number;
  azimuthDeg: number;
  elevationDeg: number;
  /**
   * 画面の「本文カードに覆われていない範囲」に収めたい地表の範囲。省略時は `distance` のまま。
   * 指定すると、カメラリグが画面の縦横比と覆われていない範囲の大きさから、この範囲が収まる距離を求め、
   * `distance` と比べて遠い方を使う（`distance` は「これより近づかない」下限）。
   */
  fit?: StoryCameraFit;
  /**
   * 本文カードが画面の下寄せに出る配置（スマートフォンの縦向き。`story/layout.ts` の 'bottom'）で使うカメラ。省略時は同じ。
   * 主役がカードの上の狭い範囲に寄るので、カードが左の列に出る配置（'side'）とは別の方位・距離が良いことがある。
   */
  portrait?: StoryCameraView;
  /**
   * 場面の中でカメラを動かすときの経由点（場面の始まりのカメラは、このキーフレームそのもの）。
   * `at` は「カメラが止まっている区間」（段階内の進捗 0〜hold）に対する割合(0〜1)。経由点のあいだは補間し、
   * 最後の経由点（場面の終わりのカメラ）から次の段階へ移る。省略時は場面の中でカメラは動かない。
   */
  stops?: readonly StoryCameraStop[];
}

/** 画面の向きごとのカメラ（`StoryCameraKeyframe` から縦長の画面用の値と経由点を除いたもの）。 */
export type StoryCameraView = Omit<StoryCameraKeyframe, 'portrait' | 'stops'>;

/** 場面の中の経由点。 */
export interface StoryCameraStop {
  /** 「カメラが止まっている区間」に対する割合(0〜1)。経由点の順に大きくする。 */
  at: number;
  camera: StoryCameraView;
  /** 本文カードが下寄せの配置（スマートフォンの縦向き）で使うカメラ。省略時は camera。 */
  portrait?: StoryCameraView;
}

/**
 * 注視点を中心とする、地表の長方形（東西・南北の幅(m)）。方位に関わらず、東西は東西、南北は南北の向きにとる。
 * 注視点の高さの水平面にある長方形として扱い、その4隅が画面の覆われていない範囲に入る距離を求める。
 * `points` があれば、長方形の代わりにそれらの点（注視点からのずれ）がすべて入る距離を求める。
 */
export interface StoryCameraFit {
  eastWestM: number;
  northSouthM: number;
  /** 収めたい点（注視点からの東・北・上へのずれ(m)）。自転車の広がりの凸包、山の裾と頂上、物差しの建物の上端など。 */
  points?: readonly StoryFitPoint[];
}

/** 注視点からのずれ(m)。 */
export interface StoryFitPoint {
  eastM: number;
  northM: number;
  /** 注視点の高さからの上へのずれ(m)。既定 0。 */
  upM?: number;
}

/** 大きく表示する数値。段階内の進捗に合わせて 0 から `value` まで数え上がる。 */
export interface StoryStat {
  value: number;
  /** 数値の右に添える単位（例: 台）。 */
  unit?: string;
  /** 数値の下に添える説明。 */
  label?: string;
  /** 小数点以下の桁数（例: 64.4% なら 1）。既定 0。 */
  fractionDigits?: number;
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
  /**
   * true なら、この段階では画面の隅に「地図を動かす」ボタンを出し、押すと OrbitControls で自由に動かせる。
   * 「読み進める」ボタンか Esc、またはこの段階を離れると語りに戻る。
   */
  freeOrbit?: boolean;
  /**
   * 段階内の進捗(0〜1)を受け取る。この段階の区間にいる間、進捗が変わるたびに呼ばれる。
   * 段階を離れるときは、進んで離れたなら 1、戻って離れたなら 0 で最後に1回呼ばれる（一度に複数の段階を飛び越えたときは、
   * 間の段階にも順に 1 または 0 が届く）。
   * 作成直後と `StoryScroll.refresh()` の後には、通り過ぎた段階へ 1、現在の段階へ現在の進捗、まだの段階へ 0 が届く
   * （途中で再読み込みしたときも 3D 側の状態を揃えられる）。同じ値で繰り返し呼ばれても良いように作る。
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
