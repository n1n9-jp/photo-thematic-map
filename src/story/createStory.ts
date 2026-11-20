/**
 * 語りの組み立て。本文カードの描画・スクロールの検出・カメラの追従をまとめて繋ぐ。
 *
 * 使い方: `createScene` で作ったシーンと段階の配列を渡し、返り値の `update(dtSec)` を毎フレーム呼ぶ。
 */
import type { SceneContext } from '../scene/createScene';
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
  rig?: CameraRigOptions;
}

export interface Story {
  scroll: StoryScroll;
  rig: CameraRig;
  /** 毎フレーム呼ぶ（レンダー前）。dtSec は前フレームからの秒数。 */
  update(dtSec: number): void;
  dispose(): void;
}

export function createStory(options: CreateStoryOptions): Story {
  const { scene, stages, root } = options;
  // 3D の canvas を画面に固定し、本文カードがその上をスクロールする。
  scene.renderer.domElement.parentElement?.classList.add('story-backdrop');

  const cards = renderStoryCards(root, stages, { reducedMotion: options.rig?.reducedMotion });
  const rig = createCameraRig(scene, stages, options.rig);
  const scroll = createStoryScroll(cards.sections, stages);

  let first = true;
  const unsubscribe = scroll.subscribe((state) => {
    cards.update(state);
    rig.setPosition(state.position, first);
    rig.setFreeOrbit(stages[state.stage]?.freeOrbit === true);
    first = false;
  });

  // フォントや画像の読み込みでレイアウトが動くので、読み込み後に位置を計算し直す。
  void document.fonts?.ready.then(() => scroll.refresh());

  return {
    scroll,
    rig,
    update: (dtSec) => rig.update(dtSec),
    dispose() {
      unsubscribe();
      scroll.dispose();
      root.replaceChildren();
    },
  };
}
