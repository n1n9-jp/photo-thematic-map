/**
 * 秋葉原の場面のモジュール（場面1 `akihabara-one`・場面2 `akihabara-462`・場面8 `since-1990`）。
 *
 * 3つの場面は同じ 462台（`AkihabaraBikes`）を共有し、表示する台数だけを変える。
 * - one: 1台（駅前の1台。置いた順の先頭）。
 * - grow: 場面内の進み具合に合わせて 1 → 462台。カメラが止まっている区間（`ctx.holdOf()`）の 85% までに増えきる。
 *   増えた分は足元の印が光る。
 * - all: 462台。
 * 場面を離れたら描かない。
 */
import type { SceneModule, SceneModuleContext, SceneModuleFactory } from '../../sceneModule';
import type { MeasureTargets } from '../../visibility';
import { AkihabaraBikes } from './bikes';
import { AKIHABARA_COUNT } from './layout';

export type AkihabaraMode = 'one' | 'grow' | 'all';

/** 場面2 で増えきる進み具合（カメラが止まっている区間に対する割合）。 */
export const GROW_END_OF_HOLD = 0.85;

/** 場面2 の進み具合から表示する台数（1〜total）。 */
export function growCount(progress: number, hold: number, total = AKIHABARA_COUNT): number {
  const end = Math.max(hold * GROW_END_OF_HOLD, 0.05);
  const t = Math.min(1, Math.max(0, progress / end));
  return 1 + Math.round((total - 1) * t);
}

let frameCounter = 0;

class AkihabaraModule implements SceneModule {
  private ctx: SceneModuleContext | null = null;
  private active = false;
  private progress = 0;

  constructor(
    readonly id: string,
    private readonly mode: AkihabaraMode,
    private readonly bikes: AkihabaraBikes,
  ) {}

  async init(ctx: SceneModuleContext): Promise<void> {
    this.ctx = ctx;
    await this.bikes.init({
      scene: ctx.scene,
      camera: ctx.camera,
      renderer: ctx.renderer,
      requestRender: ctx.requestRender,
      groundAt: (x, z) => {
        const ll = ctx.toLatLon(x, z);
        return ctx.groundHeight(ll.lat, ll.lon);
      },
    });
    this.apply(false);
  }

  private target(): number {
    if (this.mode === 'one') return 1;
    if (this.mode === 'all') return AKIHABARA_COUNT;
    return growCount(this.progress, this.ctx?.holdOf() ?? 0.4);
  }

  private apply(flash: boolean): void {
    if (this.active) this.bikes.show(this.id, this.target(), flash);
    else this.bikes.show(this.id, null);
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.apply(false);
  }

  setProgress(progress: number): void {
    if (progress === this.progress) return;
    this.progress = progress;
    if (this.mode === 'grow' && this.active) this.apply(true);
  }

  update(dtSec: number): boolean {
    if (!this.active) return false;
    return this.bikes.update(dtSec, frameCounter++);
  }

  measureTargets(): MeasureTargets | null {
    return this.active ? this.bikes.measureTargets() : null;
  }

  dispose(): void {
    this.bikes.show(this.id, null);
    this.bikes.dispose();
  }
}

/** 3つの場面のモジュールの作り方（同じ自転車を共有する）。 */
export function createAkihabaraModules(): Record<'one' | 'grow' | 'all', SceneModuleFactory> {
  let bikes: AkihabaraBikes | null = null;
  const shared = (): AkihabaraBikes => (bikes ??= new AkihabaraBikes());
  return {
    one: () => new AkihabaraModule('akihabara-one', 'one', shared()),
    grow: () => new AkihabaraModule('akihabara-462', 'grow', shared()),
    all: () => new AkihabaraModule('since-1990', 'all', shared()),
  };
}
