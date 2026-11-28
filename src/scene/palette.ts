/**
 * 街の配色（空・霧・地面・海・建物・光・駅の柱・駐輪場の空きの色）を1か所にまとめる。
 * 描画のモジュールは色を直接持たず、ここ（`PALETTE`）を参照する。色の一覧と狙い、検証の数値は `docs/design/palette/README.md`。
 *
 * 狙いは「爽やかな昼」: 澄んだ青空、若草色の地面、明るい青の海、白い建物。文字の UI（紙の色の面と墨の文字）と並んで
 * 品よく見える明るさにとどめ、主役（赤い自転車・色とりどりの自転車の山・駅の柱）を引き立てる側に置く。
 *
 * このモジュールは three.js に依存しない（E2E のテストから色を読むため）。光を作るのは `paletteLights.ts`。
 *
 * - 色は sRGB の 0xRRGGBB。
 * - 地面（`ground.ts`・`baseGround.ts`）と海は光の当たらない材質で描くので、`land`・`sea` がそのまま画面の色になる（遠くは霧で空の色へ溶ける）。
 * - 建物は Lambert の材質で、光の強さは three.js の物理的な単位（強さ π の光が正面から当たると、白い面が元の色になる）。
 *   陰の面の明るさは `ambientIntensity / π` に半球光の横向きの分を足した程度。陰の面が灰色に沈まないよう環境光を強くし、
 *   面の向きの違いは太陽で付ける（陰の面・日の当たる壁・屋上がおよそ 0.55・0.7・1.0 倍）。
 * - 駅の柱の5色（`stations`）は色相の違う定性的な配色。地面の上で、全ての組が通常の色覚で OKLab ΔE 15 以上、
 *   色覚の違い（P・D・T 型）で 8 以上離れ、駐輪場の空きの2色とアクセントの赤（`--ptm-accent`）とも 15 以上離れる
 *   （`tests/unit/palette.test.ts`）。
 */

export interface CityLights {
  /** 半球光の空側の色。 */
  hemisphereSky: number;
  /** 半球光の地面側の色（下向きの面に回り込む照り返し）。 */
  hemisphereGround: number;
  hemisphereIntensity: number;
  ambient: number;
  ambientIntensity: number;
  /** 太陽（西南西の上から）の色。 */
  sun: number;
  sunIntensity: number;
}

export interface CityPalette {
  /** 背景（空）の色。 */
  sky: number;
  /** 霧の色（遠くはこの色に溶ける）。空と同じにして、地平線に境目を出さない。 */
  fog: number;
  /** 陸の色。起伏の付いた地面はこの色に標高の陰影を掛けて描く。 */
  land: number;
  /** 海の色。 */
  sea: number;
  /** 地面の陰影。strength は明るさの倍率の振れ幅（1 ± strength）、exaggeration は傾きの誇張。 */
  relief: { strength: number; exaggeration: number };
  /** 建物の色（全ての建物で共有）。 */
  building: number;
  lights: CityLights;
  /** 駅の柱の5段階の色（台数の少ない段階から）。 */
  stations: readonly [number, number, number, number, number];
  /** 駐輪場の空きで色分けするときの色。enough: 空きが放置台数以上（青）、short: 未満（橙）。 */
  vacancy: { enough: number; short: number };
}

export const PALETTE: CityPalette = {
  sky: 0xa3d4f5,
  fog: 0xa3d4f5,
  land: 0xd3dfbd,
  sea: 0x6fb8e2,
  relief: { strength: 0.14, exaggeration: 1.5 },
  building: 0xffffff,
  lights: {
    hemisphereSky: 0xe8f4ff,
    hemisphereGround: 0xc6d6a8,
    hemisphereIntensity: 0.45,
    ambient: 0xfbfdff,
    ambientIntensity: 1.5,
    sun: 0xfffaf0,
    sunIntensity: 1.3,
  },
  // 緑・青緑・青・薄紫・ローズ
  stations: [0x4f9e11, 0x03b2c5, 0x325cbd, 0xd896ff, 0xbe678f],
  vacancy: { enough: 0x2f8cff, short: 0xff5a1f },
};
