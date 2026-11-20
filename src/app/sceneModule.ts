/**
 * 場面ごとの 3D の中身を本編へ差し込む型。
 *
 * 本編（createApp）は、台本の場面 id ごとに 1 つのモジュールを作り、次の順に呼ぶ。
 * 1. `init(ctx)`: 起動時に1回。3D オブジェクトを `ctx.scene` に足す（地面の高さは `ctx.elevationAt` で待てる）。
 * 2. `setActive(true/false)`: その場面に入った・出たとき。出た場面の物を隠すかどうかはモジュールが決める。
 * 3. `setProgress(p)`: 場面内の進捗(0〜1)が変わるたび。場面を進んで離れると 1、戻って離れると 0 が届く。
 *    同じ値で繰り返し呼ばれてもよいように作る。
 * 4. `update(dtSec)`（任意）: 毎フレーム。アニメーション中なら true を返すと、そのフレームを描画する。
 * 5. `dispose()`: 片付け。
 *
 * 3D 側の状態を変えたとき（setProgress で数を増やした、など）は `ctx.requestRender()` を呼ぶ。
 * 本編は必要なフレームだけ描画するので、呼ばないと画面に反映されない。
 */
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { Vec3 } from '../geo/enu';

export interface SceneModuleContext {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** 緯度経度(度)をローカル座標へ。altM は標高(m)。`latLonToLocal` と同じ。 */
  toLocal(lat: number, lon: number, altM?: number): Vec3;
  /** ローカル座標の水平位置 (x, z) を緯度経度(度)へ。`localToLatLon` と同じ。 */
  toLatLon(x: number, z: number): { lat: number; lon: number };
  /** 地点の標高(m)を読み込んで返す（国土地理院の標高タイル。地面の表示と同じ値）。 */
  elevationAt(lat: number, lon: number): Promise<number>;
  /**
   * 地点の標高(m)を同期で返す。`elevationAt` で読み込んだ標高タイルの範囲なら正確な値、
   * まだ読み込んでいない範囲は近くの既知の値（目安）。
   */
  groundHeight(lat: number, lon: number): number;
  /** 次のフレームで描画するよう求める。 */
  requestRender(): void;
  /**
   * この場面で「カメラが止まっている」進捗の割合（本文カードの下端が画面中央に来る進捗）。
   * これより後ろの進捗で、カメラは次の場面へ動く。中身の増え方を本文に合わせるのに使う。
   */
  holdOf(): number;
}

export interface SceneModule {
  /** 台本の場面 id。 */
  readonly id: string;
  init(ctx: SceneModuleContext): void | Promise<void>;
  setProgress(progress: number): void;
  setActive(active: boolean): void;
  update?(dtSec: number): boolean;
  dispose(): void;
}

/** 場面 id ごとのモジュールの作り方。 */
export type SceneModuleFactory = () => SceneModule;
