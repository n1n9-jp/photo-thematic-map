/**
 * 本編の地名（`scene/placeLabels.ts`）の組み込み。
 *
 * - 出す地名は、いまいる場面の一覧（`content/placeNames.ts` の `SCENE_PLACE_NAMES`）。場面の間をカメラが移っている間
 *   （場面内の進捗がカメラの止まっている区間 `hold` を過ぎてから次の場面に入るまで）は、何も出さない。
 *   場面が替わると、前の場面の地名が消え、次の場面の地名が現れる（どちらも不透明度の切り替え）。
 * - 地名を置く範囲は、本文カードに覆われていない範囲（駅のラベルと同じ `readOverlayLayout`）。
 * - 重ねないもの: 本文カード・表紙・出典表示・自由操作のボタン・読み込みの表示・駅のラベルと凡例（DOM の矩形）と、
 *   いまの場面の主役（`SceneModule.labelKeepOut`）。
 */
import type { PerspectiveCamera } from 'three';
import { localToLatLon } from '../geo/enu';
import { PlaceLabels, type LabelKeepOut, type PlaceEntry, type Rect, type ShownPlaceLabel } from '../scene/placeLabels';
import { placesForScene, SCENE_PLACE_NAMES } from '../story/content/placeNames';
import type { ScriptScene } from '../story/content/script';
import type { Story } from '../story/createStory';
import { readOverlayLayout } from './modules/stations';
import type { SceneModule } from './sceneModule';

/** 一度に出す地名の数の上限（PC 幅・スマートフォン幅）。 */
const MAX_LABELS_WIDE = 8;
const MAX_LABELS_NARROW = 5;

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

  constructor(private readonly o: PlaceLabelsLayerOptions) {
    this.labels = new PlaceLabels(o.container, { groundHeight: o.groundHeight });
    this.entries = new Map(o.script.map((s) => [s.id, placesForScene(s.id)]));
    window.__PLACE_LABELS__ = {
      scene: () => this.sceneId,
      shown: () => this.labels.shown(),
      obstacles: () => this.lastObstacles,
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

  /** 毎フレーム呼ぶ。 */
  update(): void {
    const index = this.currentStage();
    const id = index >= 0 ? (this.o.script[index]?.id ?? null) : null;
    if (id !== this.sceneId) {
      this.sceneId = id;
      // 標高タイルが読み込まれた後の地表の高さで地点を置き直すため、場面に入るたびに渡し直す
      this.labels.setPlaces([]);
      this.labels.setPlaces(id ? (this.entries.get(id) ?? []) : []);
    }
    const c = this.o.container;
    const key = `${c.clientWidth}x${c.clientHeight}|${window.innerHeight}|${id}`;
    if (this.layoutCache?.key !== key) {
      const layout = readOverlayLayout(c);
      this.layoutCache = { key, bounds: layout.region, compact: layout.compact };
    }
    const obstacles = readLabelObstacles(c);
    this.lastObstacles = obstacles;
    const keepOut: LabelKeepOut | null = index >= 0 ? (this.o.modules[index]?.labelKeepOut?.() ?? null) : null;
    const cam = this.o.camera.position;
    const ll = localToLatLon({ x: cam.x, y: 0, z: cam.z });
    this.labels.update(this.o.camera, {
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
