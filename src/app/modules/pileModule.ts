/**
 * 本編の山の場面（場面5・6・7）: 撤去された自転車が上空から降って積もる山。
 *
 * - 山の計算（Web Worker）は、起動して少したってから裏で始める（`PILE_START_DELAY_MS`）。
 *   2つの山を順に計算する（東京駅前 → 新宿。同時に動かすとスマートフォンの CPU とメモリを取り合うため）。
 *   場面に着いたときに計算が終わっていなければ、読み込み中の表示を出し、終わった時点で進み具合に追いつく（降って積もる）。
 * - 自転車のまとまりは、計算が終わったときに一度だけ登録する（`createPileSceneFromResult`）。以後は表示台数だけを変える。
 * - 同じ山を複数の場面が共有できる（場面5と7は東京駅前の山）。その山の場面のどれかにいる間だけ描き、
 *   進み具合はいまいる場面のモジュールが決める。
 * - 'grow' の場面では、カメラが止まっている区間（`holdOf()`）の前半〜中ほどで山が積もりきる。
 *   'full' の場面（場面7）では、積もりきった山を見せる。
 */
import type { PileComputeProgress, PileComputeResult, PileMode } from '../../scene/pileScene/compute';
import { computePileInWorker } from '../../scene/pileScene/computeInWorker';
import { createPileSceneFromResult, type PileScene } from '../../scene/pileScene/pileScene';
import { latLonToLocal } from '../../geo/enu';
import type { GridName } from '../../data/grids';
import type { BicycleFieldOptions } from '../../scene/bicycle/field';
import { isSmallDevice } from '../../scene/plateau/budget';
import type { SceneModule, SceneModuleContext } from '../sceneModule';
import { createPileLoadingBadge, type PileLoadingBadge } from './pileLoadingBadge';
import type { MeasureTargets } from '../visibility';
import type { LabelKeepOut } from '../../scene/placeLabels';
import { PILES } from '../../story/content/facts';

/** 格子ごとの、積もりきった山の高さと裾の直径(m)（`facts.ts` の PILES）。 */
const PILE_DIMENSIONS: Partial<Record<GridName, { heightM: number; diameterM: number }>> = Object.fromEntries(
  Object.values(PILES).map((p) => [p.grid, { heightM: p.heightM, diameterM: p.diameterM }]),
);

/** 山の定義。 */
export interface PileSiteSpec {
  /** 山の名前（共有の鍵）。 */
  key: string;
  grid: GridName;
  /** 山を積む地点（開けた地表に寄せる）。 */
  lat: number;
  lon: number;
  /** 山全体が表す台数。 */
  count: number;
  mode: PileMode;
  /** 本文の読み込み中の表示に使う名前。 */
  label: string;
}

/** 端末ごとの描画の設定。 */
export interface PileDeviceProfile {
  name: 'small' | 'large';
  field: BicycleFieldOptions;
  /** 'surface' の表層の深さ（法線方向, m）。 */
  surfaceDepth: number;
}

/**
 * 端末ごとの描画の設定。1フレームの三角形数の目安は、スマートフォン 200万、パソコン 500万。
 * - 中景（268 三角形）の台数の上限が、近づいたときの三角形数をほぼ決める。
 * - 点景（8 三角形）は、自転車が数ピクセルにしか見えない距離で遠景（38 三角形）の代わりに使う。
 */
export const PILE_DEVICE_PROFILES: Record<'small' | 'large', PileDeviceProfile> = {
  small: {
    name: 'small',
    field: { lodPixelThresholds: [110, 30], maxInstancesPerLod: [600, 3500], dotPixelThreshold: 9 },
    surfaceDepth: 0.7,
  },
  large: {
    name: 'large',
    field: { lodPixelThresholds: [90, 24], maxInstancesPerLod: [2000, 10000], dotPixelThreshold: 6 },
    surfaceDepth: 0.8,
  },
};

/** 端末の種類（`?device=small|large` で確認用に切り替えられる）。 */
export function currentPileProfile(): PileDeviceProfile {
  let forced: string | null;
  try {
    forced = new URLSearchParams(location.search).get('device');
  } catch {
    forced = null;
  }
  if (forced === 'small' || forced === 'large') return PILE_DEVICE_PROFILES[forced];
  return PILE_DEVICE_PROFILES[isSmallDevice() ? 'small' : 'large'];
}

/** 起動してから山の計算を始めるまでの時間(ms)。最初の街並みの読み込みを先に進める。 */
export const PILE_START_DELAY_MS = 1500;
/** 'grow' の場面で山が積もりきる進み具合（カメラが止まっている区間に対する割合）。 */
export const PILE_GROW_END = 0.8;

/** 場面内の進捗から山の進み具合（0〜1）。カメラが止まっている区間の PILE_GROW_END までに積もりきる。 */
export function pileProgressFor(progress: number, hold: number): number {
  const end = Math.max(hold * PILE_GROW_END, 0.05);
  return Math.min(1, Math.max(0, progress / end));
}

/** 確認用の状態。 */
export interface PileDebugStatus {
  key: string;
  state: 'waiting' | 'computing' | 'ready' | 'error';
  computeFraction: number;
  /** 計算を始めた時刻と終えた時刻（ページを開いてからの ms）。 */
  startedAtMs: number | null;
  readyAtMs: number | null;
  timings: PileComputeResult['timings'] | null;
  progress: number;
  represented: number;
  count: number;
  placed: number;
  shown: number;
  /** 落下中の台数（'full' の順位による落下。'surface' の降り直しは含まない）。 */
  falling: number;
  /** 落下・降り直しの途中か（'surface' の降り直しを含む）。 */
  animating: boolean;
  /** 最後に落下・降り直しの途中だった時刻（ページを開いてからの ms）。描画の遅い環境で、途中の状態を見逃さずに確かめるため。 */
  lastAnimatingAtMs: number | null;
  triangles: number;
  perLod: [number, number, number];
  dots: number;
  apexHeight: number;
  visible: boolean;
  profile: PileDeviceProfile['name'];
}

declare global {
  interface Window {
    /** E2E と確認用: 山の状態。 */
    __PILES__?: {
      status(key: string): PileDebugStatus | null;
      /** 「スクロールしている途中」の状態で止める（降っている自転車が空中に止まる）。on=false で戻す。 */
      freezeMidair(key: string, on: boolean): void;
    };
  }
}

/** 山ひとつぶん（計算・描画・共有の管理）。 */
class SharedPile {
  scene: PileScene | null = null;
  state: PileDebugStatus['state'] = 'waiting';
  computeFraction = 0;
  startedAtMs: number | null = null;
  readyAtMs: number | null = null;
  private ctx: SceneModuleContext | null = null;
  private promise: Promise<void> | null = null;
  private readonly owners = new Set<PileModule>();
  private driver: PileModule | null = null;
  private frozen = false;
  private lastAnimatingAtMs: number | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly spec: PileSiteSpec,
    readonly profile: PileDeviceProfile,
  ) {}

  attach(ctx: SceneModuleContext): void {
    this.ctx ??= ctx;
  }

  /** 計算を始める（2回目以降は同じ Promise）。 */
  start(): Promise<void> {
    this.promise ??= this.compute();
    return this.promise;
  }

  private async compute(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('山の場面が初期化されていません');
    this.state = 'computing';
    this.startedAtMs = performance.now();
    this.notify();
    const p = latLonToLocal({ lat: this.spec.lat, lon: this.spec.lon });
    try {
      const result = await computePileInWorker(
        this.spec.grid,
        { x: p.x, z: p.z, count: this.spec.count, mode: this.spec.mode, surfaceDepth: this.profile.surfaceDepth },
        (pr: PileComputeProgress) => {
          this.computeFraction = pr.fraction;
          this.notify();
        },
      );
      const scene = createPileSceneFromResult(result, { field: this.profile.field, surfaceDepth: this.profile.surfaceDepth });
      scene.object.visible = false;
      scene.object.name = `Pile:${this.spec.key}`;
      ctx.scene.add(scene.object);
      this.scene = scene;
      this.state = 'ready';
      this.readyAtMs = performance.now();
      this.refresh();
    } catch (err) {
      this.state = 'error';
      console.warn(`自転車の山（${this.spec.label}）の計算に失敗しました`, err);
    }
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** 場面のモジュールが場面に入った・出た。 */
  setOwnerActive(owner: PileModule, active: boolean): void {
    if (active) {
      this.owners.add(owner);
      this.driver = owner;
      // 場面に着いたのに計算を始めていなければ、すぐ始める
      void this.start();
    } else {
      this.owners.delete(owner);
      if (this.driver === owner) this.driver = [...this.owners][0] ?? null;
    }
    this.refresh();
  }

  /** 進み具合が変わった（いまの場面のモジュールの値だけを使う）。 */
  progressChanged(owner: PileModule): void {
    if (owner === this.driver) this.refresh();
  }

  get visible(): boolean {
    return this.owners.size > 0;
  }

  get driving(): PileModule | null {
    return this.driver;
  }

  private refresh(): void {
    const scene = this.scene;
    if (scene) {
      scene.object.visible = this.visible;
      if (this.driver && !this.frozen) {
        const t = this.driver.pileProgress;
        if (t !== scene.progress) scene.setProgress(t);
      }
    }
    this.ctx?.requestRender();
  }

  freezeMidair(on: boolean): void {
    const scene = this.scene;
    if (!scene) return;
    this.frozen = on;
    if (on) {
      scene.setProgress(scene.progress, { midair: true });
      scene.pauseFalls = true;
    } else {
      scene.pauseFalls = false;
      this.refresh();
    }
    this.ctx?.requestRender();
  }

  /** 毎フレーム（描くときだけ）。アニメーション中なら true。 */
  update(): boolean {
    const scene = this.scene;
    const ctx = this.ctx;
    if (!scene || !ctx || !this.visible) return false;
    const canvas = ctx.renderer.domElement;
    scene.update(ctx.camera, canvas.height / ctx.renderer.getPixelRatio());
    if (scene.animating) this.lastAnimatingAtMs = performance.now();
    return scene.animating;
  }

  /** 見えている割合を測る対象（山）。表示していなければ null。 */
  measureTargets(): MeasureTargets | null {
    const scene = this.scene;
    const ctx = this.ctx;
    if (!scene || !ctx || !this.visible) return null;
    return { subjects: [scene.object], prepare: (camera, px) => scene.update(camera, px) };
  }

  status(): PileDebugStatus {
    const s = this.scene;
    const st = s?.stats;
    return {
      key: this.spec.key,
      state: this.state,
      computeFraction: this.computeFraction,
      startedAtMs: this.startedAtMs,
      readyAtMs: this.readyAtMs,
      timings: s?.info.timings ?? null,
      progress: s?.progress ?? 0,
      represented: s ? s.representedCount() : 0,
      count: this.spec.count,
      placed: s?.info.placedCount ?? 0,
      shown: st?.shown ?? 0,
      falling: st?.falling ?? 0,
      animating: s?.animating ?? false,
      lastAnimatingAtMs: this.lastAnimatingAtMs,
      triangles: st?.triangles ?? 0,
      perLod: st ? [...st.field.perLod] : [0, 0, 0],
      dots: st?.field.dots ?? 0,
      apexHeight: s?.info.apexHeight ?? Number.NaN,
      visible: this.visible && s !== null,
      profile: this.profile.name,
    };
  }

  dispose(): void {
    this.scene?.dispose();
    this.scene = null;
  }
}

/** 山の共有の置き場（本編に1つ）。計算は登録の順に1つずつ行う。 */
export class PileRegistry {
  private readonly piles = new Map<string, SharedPile>();
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private refs = 0;

  constructor(readonly profile: PileDeviceProfile = currentPileProfile()) {}

  get(spec: PileSiteSpec): SharedPile {
    let p = this.piles.get(spec.key);
    if (!p) {
      p = new SharedPile(spec, this.profile);
      this.piles.set(spec.key, p);
    }
    return p;
  }

  find(key: string): SharedPile | undefined {
    return this.piles.get(key);
  }

  /** 起動から少したってから、登録の順に計算を始める。 */
  scheduleAll(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      for (const p of this.piles.values()) {
        this.chain = this.chain.then(() => p.start()).catch(() => undefined);
      }
    }, PILE_START_DELAY_MS);
  }

  retain(): void {
    this.refs++;
  }

  release(): void {
    this.refs--;
    if (this.refs > 0) return;
    for (const p of this.piles.values()) p.dispose();
    this.piles.clear();
    if (defaultRegistry === this) defaultRegistry = null;
  }
}

let defaultRegistry: PileRegistry | null = null;
/** 本編の共有の置き場。 */
export function pileRegistry(): PileRegistry {
  if (!defaultRegistry) {
    const reg = new PileRegistry();
    defaultRegistry = reg;
    if (typeof window !== 'undefined') {
      window.__PILES__ = {
        status: (key) => defaultRegistry?.find(key)?.status() ?? null,
        freezeMidair: (key, on) => defaultRegistry?.find(key)?.freezeMidair(on),
      };
    }
  }
  return defaultRegistry;
}

export interface PileModuleOptions {
  id: string;
  site: PileSiteSpec;
  /** 'grow': 場面の中で降って積もる。'full': 積もりきった山を見せる。 */
  growth: 'grow' | 'full';
  registry?: PileRegistry;
}

/** 山の場面のモジュール。 */
export class PileModule implements SceneModule {
  readonly id: string;
  private ctx: SceneModuleContext | null = null;
  private pile: SharedPile | null = null;
  private readonly registry: PileRegistry;
  private active = false;
  private progress = 0;
  private badge: PileLoadingBadge | null = null;
  private unsubscribe: (() => void) | null = null;
  private keepOutCache: LabelKeepOut | null = null;
  private keepOutGround = Number.NaN;

  constructor(private readonly o: PileModuleOptions) {
    this.id = o.id;
    this.registry = o.registry ?? pileRegistry();
    this.registry.retain();
  }

  init(ctx: SceneModuleContext): void {
    this.ctx = ctx;
    const pile = this.registry.get(this.o.site);
    pile.attach(ctx);
    this.pile = pile;
    this.unsubscribe = pile.onChange(() => this.updateBadge());
    this.registry.scheduleAll();
    if (this.active) pile.setOwnerActive(this, true);
  }

  /** この場面での山の進み具合（0〜1）。 */
  get pileProgress(): number {
    if (this.o.growth === 'full') return 1;
    return pileProgressFor(this.progress, this.ctx?.holdOf() ?? 0.4);
  }

  setProgress(progress: number): void {
    if (progress === this.progress) return;
    this.progress = progress;
    this.pile?.progressChanged(this);
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.pile?.setOwnerActive(this, active);
    this.updateBadge();
  }

  update(): boolean {
    if (!this.active || !this.pile || this.pile.driving !== this) return false;
    return this.pile.update();
  }

  measureTargets(): MeasureTargets | null {
    if (!this.active || !this.pile || this.pile.driving !== this) return null;
    return this.pile.measureTargets();
  }

  /**
   * 地名を重ねない形: 積もりきった山を、裾の直径の 1.05 倍の円錐で囲む（`LabelKeepOut.cones`）。頂上の横（山の後ろの駅舎の屋根など）には
   * 地名を置ける。計算が終わる前・積もる前から返す（山が積もるにつれて地名が動かないように）。
   */
  labelKeepOut(): LabelKeepOut | null {
    const ctx = this.ctx;
    if (!this.active || !ctx) return null;
    const dims = PILE_DIMENSIONS[this.o.site.grid];
    if (!dims) return null;
    const { lat, lon } = this.o.site;
    // 地表の高さ（標高タイルの読み込みで決まる）が同じあいだは、同じオブジェクトを返す（呼び出し側は参照で変化を見分ける）
    const ground = ctx.groundHeight(lat, lon);
    if (this.keepOutCache && this.keepOutGround === ground) return this.keepOutCache;
    const base = latLonToLocal({ lat, lon, alt: ground });
    this.keepOutGround = ground;
    this.keepOutCache = { cones: [{ base, radiusM: (dims.diameterM / 2) * 1.05, heightM: dims.heightM }] };
    return this.keepOutCache;
  }

  private updateBadge(): void {
    const pile = this.pile;
    const loading = this.active && pile !== null && (pile.state === 'waiting' || pile.state === 'computing');
    if (loading && !this.badge) this.badge = createPileLoadingBadge();
    this.badge?.set(loading, pile?.computeFraction ?? 0);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.pile?.setOwnerActive(this, false);
    this.badge?.dispose();
    this.badge = null;
    this.registry.release();
  }
}
