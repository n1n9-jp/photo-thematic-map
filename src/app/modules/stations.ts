/**
 * 場面3・4（都内の駅ごとの放置自転車）の 3D の中身。489か所の柱（`StationMarkers`）を、2つの場面で共有する。
 *
 * - 場面3（tokyo-13394）: 場面内の進捗に合わせて柱が地面から伸び、カメラが止まっている区間の中で伸びきる。
 *   色は台数の段階（淡い黄〜濃い紫）。
 * - 場面4（parking-vacancy）: 柱は伸びきったまま、色が「駐輪場の空きが放置台数以上／未満」に切り替わる。
 * - どちらの場面にもいないときは描かない（柱・ラベル・凡例をまとめて 0.35 秒でフェードする）。
 *
 * ラベルと凡例は、本文カードに覆われていない範囲（`story/layout.ts` の `freeRegionFor`）に収める。
 * PC 幅ではカードの列の右側（凡例は左下）、スマートフォン幅では画面の上側（凡例は小さくして左上）。
 */
import { loadStationSites, type StationSite } from '../../data/stations';
import { StationMarkers, type OverlayLayout, type Rect } from '../../scene/stationMarkers';
import { smoothstep } from '../../story/cameraPath';
import { freeRegionFor } from '../../story/layout';
import type { SceneModule, SceneModuleContext, SceneModuleFactory } from '../sceneModule';

export const STATION_SCENE_IDS = { count: 'tokyo-13394', vacancy: 'parking-vacancy' } as const;
type StationSceneId = (typeof STATION_SCENE_IDS)[keyof typeof STATION_SCENE_IDS];

/** 場面3で、柱が伸びきるまでの進捗（カメラが止まっている区間 `hold` に対する割合）。 */
const GROWTH_SPAN_OF_HOLD = 0.6;
/** 表示の切り替えにかける時間(秒)。 */
const FADE_SEC = 0.35;
/** 色の切り替えにかける時間(秒)。 */
const COLOR_SEC = 0.5;
/** ラベルを付ける駅の数。 */
const LABELS_WIDE = 10;
const LABELS_NARROW = 5;

export interface StationsDebug {
  /** 柱の数と、台数の合計。 */
  sites: number;
  total: number;
  /** いまの柱の伸び(0〜1)・表示(0〜1)・色の切り替え(0〜1)・場面。 */
  growth: number;
  visibility: number;
  colorBlend: number;
  active: string | null;
  /** 画面に出ているラベルの数。 */
  labels: number;
}

declare global {
  interface Window {
    /** E2E・確認用。 */
    __STATIONS_MAIN__?: { read(): StationsDebug; sites(): readonly StationSite[] };
  }
}

/** 本文カードに覆われていない範囲（canvas の入れ物の座標）。出典表示は障害物として返す。 */
export function readOverlayLayout(container: HTMLElement): OverlayLayout {
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  const story = document.querySelector('.story');
  const side = story !== null && getComputedStyle(story).getPropertyValue('--story-layout').trim() === 'side';
  let columnRight = 0;
  let coverTop = Number.POSITIVE_INFINITY;
  for (const card of document.querySelectorAll<HTMLElement>('.story-card')) {
    columnRight = Math.max(columnRight, card.getBoundingClientRect().right);
    const top = Number.parseFloat(getComputedStyle(card).top);
    if (Number.isFinite(top)) coverTop = Math.min(coverTop, top);
  }
  const region = freeRegionFor({
    layout: side ? 'side' : 'bottom',
    width,
    height,
    visibleHeight: window.innerHeight,
    columnRight,
    coverTop: Number.isFinite(coverTop) ? coverTop : window.innerHeight,
  });
  const obstacles: Rect[] = [];
  const box = container.getBoundingClientRect();
  for (const el of document.querySelectorAll<HTMLElement>('.ptm-site-attribution, .story-free-toggle:not([hidden])')) {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) obstacles.push({ x: b.left - box.left, y: b.top - box.top, w: b.width, h: b.height });
  }
  return {
    region: { x: region.left, y: region.top, w: region.right - region.left, h: region.bottom - region.top },
    compact: !side,
    obstacles,
  };
}

/** 2つの場面が共有する、柱・ラベル・凡例と、その状態。 */
class StationsController {
  private refs = 0;
  private ctx: SceneModuleContext | null = null;
  private markers: StationMarkers | null = null;
  private initPromise: Promise<void> | null = null;
  private active: StationSceneId | null = null;
  private countProgress = 0;
  private hold = 0.4;
  private visibility = 0;
  private colorBlend = 0;
  private layoutCache: { key: string; layout: OverlayLayout } | null = null;
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  acquire(): void {
    this.refs++;
  }

  release(): void {
    if (--this.refs > 0) return;
    this.disposed = true;
    this.markers?.object.removeFromParent();
    this.markers?.dispose();
    this.markers = null;
    this.ctx = null;
  }

  init(ctx: SceneModuleContext): Promise<void> {
    this.initPromise ??= this.build(ctx);
    return this.initPromise;
  }

  private async build(ctx: SceneModuleContext): Promise<void> {
    this.ctx = ctx;
    const sites = await loadStationSites();
    if (this.disposed) return;
    // 俯瞰（高さ 28km）では、地面の起伏（標高 0〜数十 m）は柱の高さに比べて小さい。同期で引ける標高（読み込み済みの範囲は正確、
    // それ以外は近くの値）に柱の足元を合わせ、標高の高い西側でも低い柱が地面に埋もれないようにする。
    const markers = new StationMarkers(sites, { groundY: (lat, lon) => ctx.groundHeight(lat, lon), topLabels: LABELS_WIDE });
    const container = ctx.renderer.domElement.parentElement ?? document.body;
    markers.object.name = 'stations-main';
    markers.setVisibility(this.visibility);
    markers.setColorBlend(this.colorBlend);
    markers.setLegendMode(this.active === STATION_SCENE_IDS.vacancy ? 'vacancy' : 'count');
    markers.mountOverlay(container, { layout: () => this.overlayLayout(container, markers) });
    ctx.scene.add(markers.object);
    this.markers = markers;
    window.__STATIONS_MAIN__ = {
      read: () => this.debug(),
      sites: () => sites,
    };
    this.applyState();
    ctx.requestRender();
  }

  /** ラベル・凡例の範囲。カードの列・画面の大きさが変わったときだけ測り直す。 */
  private overlayLayout(container: HTMLElement, markers: StationMarkers): OverlayLayout {
    const key = `${container.clientWidth}x${container.clientHeight}|${window.innerHeight}|${this.active}`;
    if (this.layoutCache?.key !== key) {
      const layout = readOverlayLayout(container);
      markers.setTopLabels(layout.compact ? LABELS_NARROW : LABELS_WIDE);
      this.layoutCache = { key, layout };
    }
    return this.layoutCache.layout;
  }

  setActive(id: StationSceneId, active: boolean): void {
    if (active) {
      this.active = id;
    } else if (this.active === id) {
      this.active = null;
    }
    this.layoutCache = null;
    this.applyState();
    this.ctx?.requestRender();
  }

  setProgress(id: StationSceneId, progress: number, hold: number): void {
    if (id !== STATION_SCENE_IDS.count) return;
    this.countProgress = progress;
    this.hold = hold;
    this.applyState();
    this.ctx?.requestRender();
  }

  /** 場面と進捗から、柱の伸びと凡例の意味を決める。 */
  private applyState(): void {
    const m = this.markers;
    if (!m) return;
    const span = Math.max(this.hold * GROWTH_SPAN_OF_HOLD, 0.05);
    const growth = this.active === STATION_SCENE_IDS.vacancy ? 1 : smoothstep(this.countProgress / span);
    if (this.active !== null) m.setGrowth(growth);
    m.setLegendMode(this.active === STATION_SCENE_IDS.vacancy ? 'vacancy' : 'count');
  }

  /** 毎フレーム。表示と色の切り替えを進める。動いている間は true（描画が要る）。 */
  update(dtSec: number): boolean {
    const m = this.markers;
    if (!m || !this.ctx) return false;
    let animating = false;

    const visTarget = this.active === null ? 0 : 1;
    if (this.visibility !== visTarget) {
      const step = dtSec / FADE_SEC;
      this.visibility = visTarget > this.visibility ? Math.min(visTarget, this.visibility + step) : Math.max(visTarget, this.visibility - step);
      m.setVisibility(this.visibility);
      animating = true;
    }
    // 場面にいないあいだは色を動かさない（場面を離れて消えるまでの色のまま）
    if (this.active !== null) {
      const blendTarget = this.active === STATION_SCENE_IDS.vacancy ? 1 : 0;
      if (this.colorBlend !== blendTarget) {
        const step = dtSec / COLOR_SEC;
        this.colorBlend = blendTarget > this.colorBlend ? Math.min(blendTarget, this.colorBlend + step) : Math.max(blendTarget, this.colorBlend - step);
        m.setColorBlend(this.colorBlend);
        animating = true;
      }
    }
    if (this.visibility > 0) m.update(this.ctx.camera);
    return animating;
  }

  private debug(): StationsDebug {
    const m = this.markers;
    let total = 0;
    for (const s of m?.sites ?? []) total += s.bicycles;
    return {
      sites: m?.sites.length ?? 0,
      total,
      growth: m?.growth ?? 0,
      visibility: this.visibility,
      colorBlend: this.colorBlend,
      active: this.active,
      labels: m?.visibleLabelCount ?? 0,
    };
  }
}

class StationSceneModule implements SceneModule {
  private ctx: SceneModuleContext | null = null;

  constructor(
    readonly id: StationSceneId,
    private readonly shared: StationsController,
    private readonly drivesUpdate: boolean,
  ) {
    shared.acquire();
  }

  async init(ctx: SceneModuleContext): Promise<void> {
    this.ctx = ctx;
    await this.shared.init(ctx);
  }

  setActive(active: boolean): void {
    this.shared.setActive(this.id, active);
  }

  setProgress(progress: number): void {
    this.shared.setProgress(this.id, progress, this.ctx?.holdOf() ?? 0.4);
  }

  /** 共有する状態は、片方の場面のモジュールだけが毎フレーム進める。 */
  update(dtSec: number): boolean {
    return this.drivesUpdate ? this.shared.update(dtSec) : false;
  }

  dispose(): void {
    this.shared.release();
  }
}

/**
 * 場面3・4 のモジュールの作り方。2つの場面は同じ柱を共有するので、同じアプリの中で作られた2つのモジュールが
 * 1つの `StationsController` を使う（両方が dispose されたら片付ける）。
 */
export function createStationModuleFactories(): Record<StationSceneId, SceneModuleFactory> {
  let shared: StationsController | null = null;
  const acquire = (): StationsController => {
    if (!shared || shared.isDisposed) shared = new StationsController();
    return shared;
  };
  return {
    [STATION_SCENE_IDS.count]: () => new StationSceneModule(STATION_SCENE_IDS.count, acquire(), true),
    [STATION_SCENE_IDS.vacancy]: () => new StationSceneModule(STATION_SCENE_IDS.vacancy, acquire(), false),
  };
}
