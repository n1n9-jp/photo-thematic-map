/**
 * 秋葉原駅の周りの 462台（場面1・2・8 で共有する）。
 *
 * - 配置は Web Worker で計算し（`computeAkihabaraInWorker`）、`BicycleField` に一度だけ登録する。
 *   以後は `setRevealCount` で表示する台数だけを変える（置いた順なので、先頭の k 台が「k 台のとき」）。
 * - 足元の色の印（`BikeMarkers`）は、カメラが地面から高いときだけ見せる（地上の目線では消す）。
 *   場面2 で増えた分の印は、現れた瞬間に大きく明るく光る（動きを減らす設定では明るくするだけ）。
 * - どの場面からも使われていないときは描かない。
 */
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { BicycleField } from '../../../scene/bicycle/field';
import type { MeasureTargets } from '../../visibility';
import { stationLayoutToInstances } from '../../../scene/bicycle/stationInstances';
import { computeAkihabaraInWorker } from './computeInWorker';
import type { AkihabaraLayoutResult } from './layout';
import { BikeMarkers } from './markers';

export interface AkihabaraBikesContext {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  requestRender(): void;
  /** ローカル座標 (x, z) の地面の標高(m)（カメラの地面からの高さに使う）。 */
  groundAt(x: number, z: number): number;
}

/**
 * 足元の印の半径(m)。列の中の間隔（0.5〜0.6m）より大きいので、並んだ自転車の印はつながって、通り沿いの帯に見える。
 */
const MARKER_RADIUS_M = 1.3;

/** 足元の印を見せ始める・見せきるカメラの高さ（地面から, m）。 */
const MARKER_FADE_FROM_M = 12;
const MARKER_FADE_TO_M = 45;

/** E2E・確認用の読み取り口。 */
export interface AkihabaraDebug {
  ready: boolean;
  total: number;
  /** 表示中の台数（描いていないときは 0）。 */
  shown: number;
  /** 使っている場面の id（なければ null）。 */
  owner: string | null;
  onGround: number;
  underBridge: number;
  maxDistanceM: number;
  maxFromStartM: number;
  loadMs: number;
  prepareMs: number;
  layoutMs: number;
  /** 最初の1台の位置（ローカル座標）と向き（yaw, ラジアン）。 */
  first: { x: number; y: number; z: number; yaw: number } | null;
  markerOpacity: number;
}

declare global {
  interface Window {
    __AKIHABARA__?: AkihabaraDebug;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class AkihabaraBikes {
  readonly field = new BicycleField();
  markers: BikeMarkers | null = null;
  result: (AkihabaraLayoutResult & { loadMs: number }) | null = null;
  private ctx: AkihabaraBikesContext | null = null;
  private initPromise: Promise<void> | null = null;
  private group = -1;
  private owner: string | null = null;
  private count = 0;
  private flash = false;
  private lastFrame = -1;
  readonly debug: AkihabaraDebug = {
    ready: false,
    total: 0,
    shown: 0,
    owner: null,
    onGround: 0,
    underBridge: 0,
    maxDistanceM: 0,
    maxFromStartM: 0,
    loadMs: 0,
    prepareMs: 0,
    layoutMs: 0,
    first: null,
    markerOpacity: 0,
  };

  constructor(private readonly compute: () => Promise<AkihabaraLayoutResult & { loadMs: number }> = () => computeAkihabaraInWorker()) {
    this.field.object.visible = false;
    if (typeof window !== 'undefined') window.__AKIHABARA__ = this.debug;
  }

  /** 何度呼んでも、計算と登録は1回だけ。 */
  init(ctx: AkihabaraBikesContext): Promise<void> {
    this.ctx ??= ctx;
    this.initPromise ??= this.build(ctx);
    return this.initPromise;
  }

  private async build(ctx: AkihabaraBikesContext): Promise<void> {
    const res = await this.compute();
    this.result = res;
    const { layout } = res;
    this.group = this.field.addGroup(stationLayoutToInstances(layout, { seed: 3 }), { reveal: 0 });
    // 動きを減らす設定では、現れた印を大きくせず、明るくするだけにする
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.markers = new BikeMarkers(layout.positions, layout.count, { radius: MARKER_RADIUS_M, flashScale: reduced ? 1 : 2.5 });
    this.markers.opacity = 0;
    ctx.scene.add(this.field.object);
    ctx.scene.add(this.markers.mesh);
    Object.assign(this.debug, {
      ready: true,
      total: layout.count,
      onGround: res.onGround,
      underBridge: res.underBridge,
      maxDistanceM: res.maxDistanceM,
      maxFromStartM: res.maxFromStartM,
      loadMs: res.loadMs,
      prepareMs: res.prepareMs,
      layoutMs: res.layoutMs,
      first: layout.count > 0 ? { x: layout.positions[0]!, y: layout.positions[1]!, z: layout.positions[2]!, yaw: layout.yaws[0]! } : null,
    });
    this.apply();
  }

  /**
   * 場面 owner が count 台を表示する（flash=true なら増えた分の印を光らせる）。
   * count=null で、その場面が手放す（ほかの場面が使っていれば変えない）。
   */
  show(owner: string, count: number | null, flash = false): void {
    if (count === null) {
      if (this.owner !== owner) return;
      this.owner = null;
      this.count = 0;
    } else {
      this.owner = owner;
      this.count = count;
      this.flash = flash;
    }
    this.apply();
  }

  private apply(): void {
    const shown = this.owner === null ? 0 : Math.max(0, Math.min(this.count, this.debug.total));
    this.debug.owner = this.owner;
    this.debug.shown = this.debug.ready ? shown : 0;
    if (!this.debug.ready || !this.markers) return;
    this.field.object.visible = shown > 0;
    this.field.setRevealCount(shown, this.group);
    this.markers.setShown(shown, this.flash);
    this.flash = false;
    this.ctx?.requestRender();
  }

  /** 毎フレーム（描画の前）。同じフレームに何度呼ばれても1回だけ処理する。描画を続ける必要があれば true。 */
  update(dtSec: number, frame: number): boolean {
    if (frame === this.lastFrame || !this.ctx || !this.markers) return false;
    this.lastFrame = frame;
    const { camera, renderer } = this.ctx;
    const visible = this.field.object.visible;
    const h = camera.position.y - this.ctx.groundAt(camera.position.x, camera.position.z);
    const opacity = visible ? smoothstep(MARKER_FADE_FROM_M, MARKER_FADE_TO_M, h) : 0;
    let needed = false;
    if (Math.abs(opacity - this.markers.opacity) > 1e-3) {
      this.markers.opacity = opacity;
      needed = true;
    }
    this.debug.markerOpacity = this.markers.opacity;
    if (this.markers.update(dtSec)) needed = true;
    if (visible) {
      const px = renderer.domElement.height / renderer.getPixelRatio();
      this.field.update(camera, px);
    }
    return needed;
  }

  /** 見えている割合を測る対象（表示中の自転車。足元の印は測らない）。表示していなければ null。 */
  measureTargets(): MeasureTargets | null {
    if (!this.markers || !this.field.object.visible || this.debug.shown === 0) return null;
    return {
      subjects: [this.field.object],
      hide: [this.markers.mesh],
      samples: this.samplePoints(this.debug.shown),
      prepare: (camera, px) => {
        // 詳細度の切り替えには余裕幅（直前の詳細度に依る）があるので、測るたびに直前の詳細度を忘れさせ、
        // どの場面から来ても同じ詳細度で測る（forceLod を切り替えると、次の update で割り当てをやり直す）
        this.field.forceLod = 0;
        this.field.forceLod = null;
        this.field.update(camera, px);
      },
    };
  }

  /**
   * 表示中の自転車 1 台ごとに 3 点（前輪の上・サドルの下・後輪の上。地面から 0.45〜0.55m）の標本点（見えている台数を数える）。
   */
  private samplePoints(count: number): { points: Float32Array; perItem: number } | undefined {
    const layout = this.result?.layout;
    if (!layout) return undefined;
    const n = Math.min(count, layout.count);
    const half = (layout.bikeLength ?? 1.8) * 0.33;
    const points = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const x = layout.positions[i * 3]!;
      const y = layout.positions[i * 3 + 1]!;
      const z = layout.positions[i * 3 + 2]!;
      // 自転車の前後の向き（`stationLayout` と同じ: yaw は Y 軸まわり、前は (cos, 0, -sin)）
      const fx = Math.cos(layout.yaws[i]!);
      const fz = -Math.sin(layout.yaws[i]!);
      points.set([x + fx * half, y + 0.45, z + fz * half, x, y + 0.55, z, x - fx * half, y + 0.45, z - fz * half], i * 9);
    }
    return { points, perItem: 3 };
  }

  dispose(): void {
    this.field.object.removeFromParent();
    this.field.dispose();
    this.markers?.dispose();
  }
}
