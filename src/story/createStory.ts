/**
 * 語りの組み立て。本文カードの描画・スクロールの検出・カメラの追従・自由操作のボタンをまとめて繋ぐ。
 *
 * 使い方: `createScene` で作ったシーンと段階の配列を渡し、返り値の `update(dtSec)` を毎フレーム呼ぶ。
 * `update` が false を返したフレームは、カメラも語りの状態も変わっていないので描画を省いてよい
 * （`onProgress` などで 3D 側を変えたときは、呼び出し側で描画する）。
 */
import { Vector2 } from 'three';
import { localToLatLon } from '../geo/enu';
import type { SceneContext } from '../scene/createScene';
import { defaultGroundY, type GroundYAt } from './cameraPath';
import { createCameraRig, type CameraRig, type CameraRigOptions } from './cameraRig';
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
   * canvas の高さを、アドレスバーの出入りで変わらない高さ（100lvh）に固定し、タッチ端末で高さだけが少し変わる
   * リサイズでは描画バッファを作り直さない（そのリサイズは window の他のリスナーにも届かない）。既定 true。
   */
  stableViewport?: boolean;
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

/** 幅が変わらず高さだけが変わる、この割合未満のリサイズはアドレスバーの出入りとみなす。 */
const MINOR_HEIGHT_CHANGE = 0.25;

export function createStory(options: CreateStoryOptions): Story {
  const { scene, stages, root } = options;
  const groundY = options.groundY ?? defaultGroundY;
  const stableViewport = options.stableViewport ?? true;
  const canvas = scene.renderer.domElement;
  const backdrop = canvas.parentElement;
  let disposed = false;
  let dirty = true;

  // 3D の canvas を画面に固定し、本文カードがその上をスクロールする。
  const addedBackdrop = backdrop !== null && !backdrop.classList.contains('story-backdrop');
  backdrop?.classList.add('story-backdrop');
  if (stableViewport) backdrop?.classList.add('story-backdrop--stable');

  const cards = renderStoryCards(root, stages, { reducedMotion: options.rig?.reducedMotion });
  const scroll = createStoryScroll(cards.sections, stages);
  const rig = createCameraRig(scene, stages, {
    ...options.rig,
    groundY,
    groundHeightAt: (x, z) => {
      const p = localToLatLon({ x, y: 0, z });
      return groundY(p.lat, p.lon);
    },
    hold: scroll.getHolds(),
  });

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
    }
    rig.setPosition(state.position, first);
    const allowed = stages[state.stage]?.freeOrbit === true;
    if (!allowed) setFreeOrbit(false);
    toggle.hidden = !allowed;
    first = false;
    dirty = true;
  });

  // 描画バッファを、アドレスバーの出入りで変わらない高さ（backdrop の高さ = 100lvh）に合わせる。
  function fitRenderer(): void {
    if (!stableViewport || !backdrop) return;
    const w = window.innerWidth;
    const h = backdrop.clientHeight || window.innerHeight;
    const r = scene.renderer;
    const size = r.getSize(new Vector2());
    if (size.x === w && size.y === h) return;
    r.setSize(w, h, false);
    scene.camera.aspect = w / h;
    scene.camera.updateProjectionMatrix();
    dirty = true;
  }

  let lastWidth = window.innerWidth;
  let lastHeight = window.innerHeight;
  const isTouch = (): boolean => navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
  // createScene などの resize リスナーより先に呼ばれる（捕捉フェーズ）。
  const onResizeCapture = (e: Event): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === lastWidth && Math.abs(h - lastHeight) < lastHeight * MINOR_HEIGHT_CHANGE && isTouch()) {
      // アドレスバーの出入り。canvas の高さは 100lvh で変わらないので、描画バッファを作り直させない。
      e.stopImmediatePropagation();
      return;
    }
    lastWidth = w;
    lastHeight = h;
  };
  // ほかのリスナー（createScene の setSize）の後に、高さを 100lvh に合わせ直す。
  const onResize = (): void => {
    fitRenderer();
    dirty = true;
  };
  if (stableViewport) window.addEventListener('resize', onResizeCapture, { capture: true });
  window.addEventListener('resize', onResize);
  fitRenderer();

  // フォントや画像の読み込みでレイアウトが動くので、読み込み後に位置を計算し直す。
  void document.fonts?.ready.then(() => {
    if (!disposed) scroll.refresh();
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
      if (stableViewport) window.removeEventListener('resize', onResizeCapture, { capture: true });
      window.removeEventListener('resize', onResize);
      toggle.remove();
      root.classList.remove('story', 'story--free');
      root.replaceChildren();
      if (addedBackdrop) backdrop?.classList.remove('story-backdrop');
      backdrop?.classList.remove('story-backdrop--stable');
    },
  };
}
