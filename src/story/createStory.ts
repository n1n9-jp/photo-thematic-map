/**
 * 語りの組み立て。本文カードの描画・スクロールの検出・カメラの追従・自由操作のボタンをまとめて繋ぐ。
 *
 * 使い方: `createScene` で作ったシーンと段階の配列を渡し、返り値の `update(dtSec)` を毎フレーム呼ぶ。
 * `update` が false を返したフレームは、カメラも語りの状態も変わっていないので描画を省いてよい
 * （`onProgress` などで 3D 側を変えたときは、呼び出し側で描画する）。
 */
import { localToLatLon } from '../geo/enu';
import type { SceneContext } from '../scene/createScene';
import { defaultGroundY, type GroundYAt } from './cameraPath';
import { createCameraRig, type CameraRig, type CameraRigOptions } from './cameraRig';
import { freeRegionFor, viewShiftFor } from './layout';
import { renderStoryCards } from './storyCards';
import { createStoryScroll, type StoryScroll } from './storyScroll';
import type { StoryStage } from './types';
import './story.css';

export interface CreateStoryOptions {
  scene: Pick<SceneContext, 'camera' | 'controls' | 'renderer'>;
  stages: readonly StoryStage[];
  /** 本文カードを入れる要素。中身は作り直される。 */
  root: HTMLElement;
  /**
   * 地点の地表のローカル Y(m)。キーフレームの注視点の Y は `groundY(lat, lon) + target.alt` になり、
   * カメラは地表から `rig.minClearance` 以上の高さに保たれる。既定は `latLonToLocal` で高さ 0 として求めた Y。
   */
  groundY?: GroundYAt;
  rig?: Omit<CameraRigOptions, 'groundY' | 'groundHeightAt' | 'hold'>;
  /**
   * canvas の入れ物（canvas の親要素）の高さを、アドレスバーの出入りで変わらない高さ（100lvh）に固定する。既定 true。
   * 描画バッファの大きさは `createScene` が入れ物の大きさに合わせる（ResizeObserver）ので、入れ物の高さが
   * 変わらなければ作り直されない。入れ物の高さが変わる作りでアドレスバーの出入りを無視したいときは、
   * `createScene` の `stableViewport` を使う。
   */
  stableViewport?: boolean;
  /**
   * 注視点を「本文カードに覆われていない範囲」の中央に置く（投影の中心だけをずらす。カメラの向きは変えない）。既定 true。
   * 左に列で出る配置では、列を除いた右側の中央。画面の下寄りに出る配置では、カードの上の範囲の中央。
   */
  centerInFreeRegion?: boolean;
  /** 自由操作のボタンの文言。 */
  labels?: { explore?: string; resume?: string };
}

export interface Story {
  scroll: StoryScroll;
  rig: CameraRig;
  /**
   * 毎フレーム呼ぶ（レンダー前）。dtSec は前フレームからの秒数。
   * 戻り値は描画が必要か（カメラが動いた・語りの状態が変わった・自由操作の入力があった・リサイズした）。
   */
  update(dtSec: number): boolean;
  /** 自由操作を始める・やめる。`freeOrbit` でない段階では始められない。 */
  setFreeOrbit(on: boolean): void;
  /** 自由操作のボタン。 */
  readonly freeToggle: HTMLButtonElement;
  dispose(): void;
}

export function createStory(options: CreateStoryOptions): Story {
  const { scene, stages, root } = options;
  const groundY = options.groundY ?? defaultGroundY;
  const stableViewport = options.stableViewport ?? true;
  const centerInFreeRegion = options.centerInFreeRegion ?? true;
  const canvas = scene.renderer.domElement;
  const backdrop = canvas.parentElement;
  let disposed = false;
  let dirty = true;

  // 3D の canvas を画面に固定し、本文カードがその上をスクロールする。
  const addedBackdrop = backdrop !== null && !backdrop.classList.contains('story-backdrop');
  backdrop?.classList.add('story-backdrop');
  if (stableViewport) backdrop?.classList.add('story-backdrop--stable');

  const cards = renderStoryCards(root, stages, { reducedMotion: options.rig?.reducedMotion });
  const scroll = createStoryScroll(cards.sections, stages, { holdScrollY: (section) => cards.holdScrollY(section) });
  const rig = createCameraRig(scene, stages, {
    ...options.rig,
    groundY,
    groundHeightAt: (x, z) => {
      const p = localToLatLon({ x, y: 0, z });
      return groundY(p.lat, p.lon);
    },
    hold: scroll.getHolds(),
  });

  /** 注視点を、カードに覆われていない範囲の中央へ置く。レイアウトが変わるたびに計算し直す。 */
  function syncViewShift(): void {
    if (!centerInFreeRegion || disposed) return;
    const info = cards.layoutInfo();
    const width = canvas.clientWidth || document.documentElement.clientWidth;
    const height = canvas.clientHeight || window.innerHeight;
    if (width <= 0 || height <= 0) return;
    const region = freeRegionFor({
      layout: info.layout,
      width,
      height,
      visibleHeight: window.innerHeight,
      columnRight: info.columnRight,
      coverTop: info.coverTop,
    });
    rig.setViewShift(viewShiftFor(region, width, height));
    rig.setFitFrame({ canvasWidth: width, canvasHeight: height, regionWidth: region.right - region.left, regionHeight: region.bottom - region.top });
    dirty = true;
  }
  syncViewShift();

  // 自由操作のボタン。freeOrbit の段階でだけ表示し、自由操作の間は「読み進める」になる。
  const labels = { explore: '地図を動かす', resume: '読み進める', ...options.labels };
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'story-free-toggle';
  toggle.hidden = true;
  toggle.setAttribute('aria-pressed', 'false');
  toggle.textContent = labels.explore;
  root.after(toggle);

  let stageIndex = scroll.getState().stage;

  function setFreeOrbit(on: boolean): void {
    const allowed = stages[stageIndex]?.freeOrbit === true;
    const next = on && allowed;
    if (next === rig.isFree) return;
    rig.setFreeOrbit(next);
    root.classList.toggle('story--free', next);
    toggle.setAttribute('aria-pressed', String(next));
    toggle.textContent = next ? labels.resume : labels.explore;
    dirty = true;
  }

  const onToggle = (): void => setFreeOrbit(!rig.isFree);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && rig.isFree) setFreeOrbit(false);
  };
  toggle.addEventListener('click', onToggle);
  document.addEventListener('keydown', onKeyDown);

  let first = true;
  let holds = scroll.getHolds();
  const unsubscribe = scroll.subscribe((state) => {
    stageIndex = state.stage;
    cards.update(state);
    const nextHolds = scroll.getHolds();
    if (nextHolds !== holds) {
      holds = nextHolds;
      rig.setHolds(holds);
      // 位置を計算し直したあと（リサイズ・フォントの読み込み後を含む）は、カードの配置も変わっている。
      syncViewShift();
    }
    rig.setPosition(state.position, first);
    const allowed = stages[state.stage]?.freeOrbit === true;
    if (!allowed) setFreeOrbit(false);
    toggle.hidden = !allowed;
    first = false;
    dirty = true;
  });

  // リサイズ（描画バッファの大きさは createScene が合わせる）の後は描画し直す。
  const onResize = (): void => {
    dirty = true;
    // カードの高さと列の幅が変わるので、画面の向きが変わった直後にもずらし量を合わせる。
    cards.measure();
    syncViewShift();
  };
  window.addEventListener('resize', onResize);

  // フォントや画像の読み込みでレイアウトが動くので、読み込み後に位置を計算し直す。
  void document.fonts?.ready.then(() => {
    if (disposed) return;
    scroll.refresh();
    syncViewShift();
  });

  return {
    scroll,
    rig,
    freeToggle: toggle,
    setFreeOrbit,
    update(dtSec) {
      const moved = rig.update(dtSec);
      const needed = moved || dirty;
      dirty = false;
      return needed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      scroll.dispose();
      cards.dispose();
      rig.dispose();
      toggle.removeEventListener('click', onToggle);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      toggle.remove();
      root.classList.remove('story', 'story--free');
      root.replaceChildren();
      if (addedBackdrop) backdrop?.classList.remove('story-backdrop');
      backdrop?.classList.remove('story-backdrop--stable');
    },
  };
}
