/**
 * 本編の地名（`scene/placeLabels.ts`）の組み込み。
 *
 * - 出す地名は、いまいる場面の一覧（`content/placeNames.ts` の `SCENE_PLACE_NAMES`）。場面の間をカメラが移っている間
 *   （場面内の進捗がカメラの止まっている区間 `hold` を過ぎてから次の場面に入るまで）は、何も出さない。
 *   場面が替わると、前の場面の地名が消え、次の場面の地名が現れる（どちらも不透明度の切り替え）。
 * - 地名を置く範囲は、本文カードに覆われていない範囲（駅のラベルと同じ `readOverlayLayout`）。
 * - 重ねないもの: 本文カード・表紙・出典表示・自由操作のボタン・読み込みの表示・駅のラベルと凡例（DOM の矩形）と、
 *   いまの場面の主役（`SceneModule.labelKeepOut`）。
 * - 毎フレームの負荷: カメラの行列・スクロール位置・画面の大きさ・場面・主役の形（モジュールが作り置いたもの）・読み込みの表示の
 *   状態を、確保なしで前のフレームと比べ（`ChangeTracker`）、どれも変わらず、変わってから `SETTLE_MS` が過ぎ、消えかけの地名も
 *   なければ、DOM を読まずに戻る。変わってからしばらく読み続けるのは、本文カード・駅のラベル・凡例の不透明度の切り替え
 *   （0.35 秒）が、カメラが止まった後にも進むため。
 */
import type { PerspectiveCamera } from 'three';
import { localToLatLon } from '../geo/enu';
import { ChangeTracker, PlaceLabels, type LabelKeepOut, type PlaceEntry, type Rect, type ShownPlaceLabel } from '../scene/placeLabels';
import { placesForScene, SCENE_PLACE_NAMES } from '../story/content/placeNames';
import type { ScriptScene } from '../story/content/script';
import type { Story } from '../story/createStory';
import { readOverlayLayout } from './modules/stations';
import type { SceneModule } from './sceneModule';

/** 一度に出す地名の数の上限（PC 幅・スマートフォン幅）。 */
const MAX_LABELS_WIDE = 8;
const MAX_LABELS_NARROW = 5;
/** 何かが変わってから、DOM を読み続ける時間(ms)。本文カード・駅のラベル・凡例の不透明度の切り替え（最長 0.35 秒）が終わるまで。 */
const SETTLE_MS = 600;

/** 地名を重ねない DOM の要素。 */
const OBSTACLE_SELECTOR = [
  '.story-card',
  '.ptm-cover__panel',
  '.ptm-site-attribution',
  '.story-free-toggle:not([hidden])',
  '.ptm-loading',
  '.ptm-pile-loading',
].join(',');

export interface PlaceLabelsDebug {
  /** いま出している場面の id（場面の間を移っている間は null）。 */
  scene(): string | null;
  shown(): readonly ShownPlaceLabel[];
  /** 重ねない DOM の矩形（canvas の入れ物の座標）。 */
  obstacles(): Rect[];
  /** 主役を画面に投影した矩形（重ねない範囲。canvas の入れ物の座標）。 */
  keepOut(): readonly Rect[];
  /** 地名を置き直した回数（変わらないフレームで置き直していないことの確認用）。 */
  updates(): number;
}

declare global {
  interface Window {
    /** E2E・確認用。 */
    __PLACE_LABELS__?: PlaceLabelsDebug;
  }
}

/** 要素の矩形（入れ物の左上が原点）。見えていなければ null。 */
function visibleRect(el: HTMLElement, box: DOMRect): Rect | null {
  if (el.hidden) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
}

/** 画面を覆う DOM の矩形。駅のラベルと凡例は、その重ね表示が見えているときだけ。 */
export function readLabelObstacles(container: HTMLElement): Rect[] {
  const box = container.getBoundingClientRect();
  const out: Rect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(OBSTACLE_SELECTOR)) {
    const r = visibleRect(el, box);
    if (r) out.push(r);
  }
  for (const overlay of document.querySelectorAll<HTMLElement>('.sm-overlay')) {
    if (overlay.style.visibility === 'hidden' || Number(overlay.style.opacity || '1') <= 0.05) continue;
    for (const el of overlay.querySelectorAll<HTMLElement>('.sm-label, .sm-legend')) {
      if (el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
    }
  }
  return out;
}

export interface PlaceLabelsLayerOptions {
  container: HTMLElement;
  script: readonly ScriptScene[];
  story: Story;
  camera: PerspectiveCamera;
  /** 場面ごとの 3D の中身（台本と同じ並び。中身のない場面は null）。 */
  modules: readonly (SceneModule | null)[];
  /** 注視点（ローカル座標）。 */
  target: () => { x: number; y: number; z: number };
  /** 地点の標高(m)。 */
  groundHeight: (lat: number, lon: number) => number;
}

export class PlaceLabelsLayer {
  private readonly labels: PlaceLabels;
  private readonly entries: Map<string, PlaceEntry[]>;
  private sceneId: string | null = null;
  private layoutCache: { key: string; bounds: Rect; compact: boolean } | null = null;
  private lastObstacles: Rect[] = [];
  private readonly tracker = new ChangeTracker();
  /** 比べる値（確保しない）: カメラの行列 16 × 2、スクロール 2、大きさ 3、場面、主役の形の版、読み込みの表示 2。 */
  private readonly values = new Float64Array(16 * 2 + 2 + 3 + 1 + 1 + 2);
  private keepOutRef: LabelKeepOut | null = null;
  private keepOutVersion = 0;
  private settleUntil = 0;
  private updateCount = 0;
  /** 読み込みの表示（data-state が 'loading' の間は障害物になる）。生きた一覧なので、毎フレーム探さない。 */
  private readonly loadingEls = document.getElementsByClassName('ptm-loading');
  private readonly pileLoadingEls = document.getElementsByClassName('ptm-pile-loading');

  constructor(private readonly o: PlaceLabelsLayerOptions) {
    this.labels = new PlaceLabels(o.container, { groundHeight: o.groundHeight });
    this.entries = new Map(o.script.map((s) => [s.id, placesForScene(s.id)]));
    window.__PLACE_LABELS__ = {
      scene: () => this.sceneId,
      shown: () => this.labels.shown(),
      obstacles: () => this.lastObstacles,
      keepOut: () => this.labels.keepOut(),
      updates: () => this.updateCount,
    };
  }

  /** いま地名を出す場面（場面の間を移っている間は -1）。 */
  private currentStage(): number {
    const { stage, progress } = this.o.story.scroll.getState();
    if (this.o.story.rig.isFree) return stage;
    const hold = this.o.story.scroll.getHolds()[stage] ?? 0.4;
    if (progress <= hold || stage + 1 >= this.o.script.length) return stage;
    // 次の場面も同じ地名を出すとき（場面3→4: 同じ俯瞰で向きだけ変わる）は、消さずに出し続ける
    const here = SCENE_PLACE_NAMES[this.o.script[stage]!.id];
    return here !== undefined && here === SCENE_PLACE_NAMES[this.o.script[stage + 1]!.id] ? stage : -1;
  }

  /** 読み込みの表示の状態（読み込み中なら 1）。 */
  private static loadingState(list: HTMLCollectionOf<Element>): number {
    const el = list[0] as HTMLElement | undefined;
    return el && el.dataset.state !== 'idle' ? 1 : 0;
  }

  /** 毎フレーム呼ぶ。何も変わらないフレームでは、DOM を読まずに戻る。 */
  update(): void {
    const index = this.currentStage();
    const id = index >= 0 ? (this.o.script[index]?.id ?? null) : null;
    if (id !== this.sceneId) {
      this.sceneId = id;
      // 標高タイルが読み込まれた後の地表の高さで地点を置き直すため、場面に入るたびに渡し直す
      this.labels.setPlaces([]);
      this.labels.setPlaces(id ? (this.entries.get(id) ?? []) : []);
    }
    const keepOut: LabelKeepOut | null = index >= 0 ? (this.o.modules[index]?.labelKeepOut?.() ?? null) : null;
    if (keepOut !== this.keepOutRef) {
      this.keepOutRef = keepOut;
      this.keepOutVersion++;
    }

    // 変化の判定（DOM のレイアウトを読まない値だけ）
    const camera = this.o.camera;
    camera.updateMatrixWorld();
    const c = this.o.container;
    const v = this.values;
    v.set(camera.matrixWorld.elements, 0);
    v.set(camera.projectionMatrix.elements, 16);
    v[32] = window.scrollX;
    v[33] = window.scrollY;
    v[34] = c.clientWidth;
    v[35] = c.clientHeight;
    v[36] = window.innerHeight;
    v[37] = index;
    v[38] = this.keepOutVersion;
    v[39] = PlaceLabelsLayer.loadingState(this.loadingEls);
    v[40] = PlaceLabelsLayer.loadingState(this.pileLoadingEls);
    const now = performance.now();
    if (this.tracker.changed(v)) this.settleUntil = now + SETTLE_MS;
    if (now > this.settleUntil && !this.labels.dirty && !this.labels.animating) return;

    this.updateCount++;
    const key = `${c.clientWidth}x${c.clientHeight}|${window.innerHeight}|${id}`;
    if (this.layoutCache?.key !== key) {
      const layout = readOverlayLayout(c);
      this.layoutCache = { key, bounds: layout.region, compact: layout.compact };
    }
    const obstacles = readLabelObstacles(c);
    this.lastObstacles = obstacles;
    const cam = camera.position;
    const ll = localToLatLon({ x: cam.x, y: 0, z: cam.z });
    this.labels.update(camera, {
      bounds: this.layoutCache.bounds,
      obstacles,
      keepOut,
      heightAboveGround: cam.y - this.o.groundHeight(ll.lat, ll.lon),
      target: this.o.target(),
      maxLabels: this.layoutCache.compact ? MAX_LABELS_NARROW : MAX_LABELS_WIDE,
    });
  }

  dispose(): void {
    this.labels.dispose();
    if (window.__PLACE_LABELS__) delete window.__PLACE_LABELS__;
  }
}
