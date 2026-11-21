/**
 * スクロール連動の語りの確認ページ。仮の本文で4段階（箱の接写 → 100m → 1km → 10km 上空）を定義する。
 * 本文は、段階ごとに小さなカード（最初は見出しと数値、つづいて段落を1つずつ）に分かれて流れる。
 * `?long=1` を付けると、2番目の段階の本文を長くする（カードが多い場面の確認用）。
 */
import {
  BoxGeometry,
  ConeGeometry,
  DataTexture,
  Fog,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { ORIGIN } from '../config';
import { latLonToLocal } from '../geo/enu';
import { createScene } from '../scene/createScene';
import { createStory } from '../story/createStory';
import { distanceForHeight } from '../story/cameraPath';
import type { StoryStage } from '../story/types';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E 用の読み取り口。 */
    __STORY__?: {
      getState(): { stage: number; progress: number; position: number };
      getCameraPosition(): { x: number; y: number; z: number };
      /** 注視点の画面上の位置（canvas の左上を原点とする CSS px）。 */
      targetOnScreen(): { x: number; y: number };
      isFree(): boolean;
      scrollYFor(stage: number, progress: number): number;
      getHolds(): readonly number[];
      /** 描画したフレームの数。 */
      renderCount(): number;
    };
    /** 段階の id ごとに、最後に `onProgress` へ渡された進捗。 */
    __STORY_PROGRESS__?: Record<string, number>;
  }
}

const container = document.getElementById('app');
const storyRoot = document.getElementById('story');
if (!container || !storyRoot) throw new Error('#app / #story が見つかりません');

const ctx = createScene(container);

// 土台の最小シーンは 1km 四方なので、10km の俯瞰に耐えるよう地面を広げる（near / far はカメラリグが設定する）。
ctx.scene.fog = new Fog(0x9ec9ee, 12_000, 80_000);

const checker = new DataTexture(
  new Uint8Array([
    176, 180, 168, 255, 154, 158, 146, 255, //
    154, 158, 146, 255, 176, 180, 168, 255,
  ]),
  2,
  2,
  RGBAFormat,
  UnsignedByteType,
);
checker.wrapS = checker.wrapT = RepeatWrapping;
checker.magFilter = NearestFilter;
checker.minFilter = LinearMipmapLinearFilter;
checker.generateMipmaps = true;
checker.colorSpace = SRGBColorSpace;
checker.repeat.set(250, 250); // 200m 角のチェッカー
checker.needsUpdate = true;
const wideGround = new Mesh(new PlaneGeometry(100_000, 100_000), new MeshStandardMaterial({ map: checker, roughness: 1 }));
wideGround.rotation.x = -Math.PI / 2;
wideGround.position.y = -3;
ctx.scene.add(wideGround);

// 高さの目安になる柱（50m 角、高さ 60〜300m）。
const pillarMaterial = new MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.8 });
[
  [-120, -160, 60],
  [150, -220, 120],
  [-260, 90, 180],
  [300, 260, 300],
  [-400, -420, 240],
].forEach(([x, z, h]) => {
  const pillar = new Mesh(new BoxGeometry(50, h, 50), pillarMaterial);
  pillar.position.set(x ?? 0, (h ?? 0) / 2, z ?? 0);
  ctx.scene.add(pillar);
});

/** 緯度経度は東京駅（`ORIGIN`）の近く。distance は「高さ ÷ sin(仰角)」で、見た目の高さに合わせる。 */
const stages: StoryStage[] = [
  {
    id: 'closeup',
    text: {
      heading: '1台の自転車',
      paragraphs: [
        'これは仮の本文です。駅前に置かれた1台の自転車を、目の高さで見てみます。',
        'ここから少しずつ、カメラを引いていきます。',
      ],
      stat: { value: 1, unit: '台', label: '仮の数値。いまは箱が1つあるだけです' },
    },
    camera: { target: { ...ORIGIN, alt: 5 }, distance: 34, azimuthDeg: 35, elevationDeg: 14 },
  },
  {
    id: 'above-100m',
    text: {
      heading: '100m上空から',
      paragraphs: [
        'これは仮の本文です。駅前の広場ひとつぶんを見下ろすと、さっきの箱がずいぶん小さく見えます。',
      ],
      stat: { value: 1_200, unit: '台', label: '仮の数値。1日ぶんを想定' },
    },
    camera: { target: { ...ORIGIN, alt: 0 }, distance: distanceForHeight(100, 50), azimuthDeg: 35, elevationDeg: 50 },
  },
  {
    id: 'above-1km',
    text: {
      heading: '1km上空から',
      paragraphs: [
        'これは仮の本文です。中央の緑の四角い地面は一辺1kmです。チェッカーの一目は200mです。',
      ],
      stat: { value: 438_000, unit: '台', label: '仮の数値。1年ぶんを想定' },
    },
    camera: { target: { ...ORIGIN, alt: 0 }, distance: distanceForHeight(1000, 55), azimuthDeg: 35, elevationDeg: 55 },
  },
  {
    id: 'above-10km',
    text: {
      heading: '東京全体へ',
      paragraphs: [
        'これは仮の本文です。10km上空からの俯瞰です。ここから先は、ドラッグして自由に見回せます。',
      ],
      stat: { value: 7_300_000, unit: '台', label: '仮の数値。東京全体を想定' },
    },
    camera: {
      target: { lat: ORIGIN.lat + 0.01, lon: ORIGIN.lon + 0.01, alt: 0 },
      distance: distanceForHeight(10_000, 60),
      azimuthDeg: 35,
      elevationDeg: 60,
    },
    freeOrbit: true,
  },
];

// 画面上での注視点の位置の目印（赤い円錐）。最後の場面だけ注視点が箱の位置から外れているので、そこに立てる。
{
  const last = stages[stages.length - 1];
  if (last) {
    const p = latLonToLocal({ ...last.camera.target, alt: 0 });
    const cone = new Mesh(new ConeGeometry(250, 900, 16), new MeshStandardMaterial({ color: 0xc8402b, roughness: 0.7 }));
    cone.position.set(p.x, 450 - 3, p.z);
    ctx.scene.add(cone);
  }
}

const LONG_PARAGRAPHS = [
  'これは仮の長い本文です。狭い画面では、本文カードが画面の高さを超えることがあります。そのときも、数値はカードの下の方にあり、読み進めて画面に入ってから数え上がります。',
  'カメラは、本文を読んでいる間は止まっています。カードの下端が画面の中央より上に来て、カード全体が画面の上へ抜けはじめてから、次の場面へ動き出します。',
  'ここには、記事の本文が何段落も続くことを想定した文章を置いています。駅前の自転車の台数、撤去の回数、保管所までの距離など、数字の背景を説明する文章です。',
  'さらにもう一段落。スマートフォンで読む人が多いので、幅320pxの画面でも読みやすい行の長さと文字の大きさを保ちます。',
  '最後の段落です。この下に、大きな数値があります。',
];
if (new URLSearchParams(location.search).get('long') === '1') {
  const s = stages[1];
  if (s) s.text = { ...s.text, paragraphs: LONG_PARAGRAPHS };
}

// E2E 用に、各段階の onProgress に最後に渡された進捗を記録する。
const progressLog: Record<string, number> = {};
window.__STORY_PROGRESS__ = progressLog;
for (const s of stages) {
  s.onProgress = (p) => {
    progressLog[s.id] = p;
  };
}

const story = createStory({ scene: ctx, stages, root: storyRoot });
let renders = 0;

window.__STORY__ = {
  getState: () => story.scroll.getState(),
  getCameraPosition: () => {
    const { x, y, z } = ctx.camera.position;
    return { x, y, z };
  },
  targetOnScreen: () => {
    ctx.camera.updateMatrixWorld();
    const v = ctx.controls!.target.clone().project(ctx.camera);
    return { x: ((v.x + 1) / 2) * ctx.renderer.domElement.clientWidth, y: ((1 - v.y) / 2) * ctx.renderer.domElement.clientHeight };
  },
  isFree: () => story.rig.isFree,
  scrollYFor: (stage, progress) => story.scroll.scrollYFor(stage, progress),
  getHolds: () => story.scroll.getHolds(),
  renderCount: () => renders,
};

let last = performance.now();
ctx.renderer.setAnimationLoop((now: number) => {
  // カメラも語りの状態も変わっていないフレームは描画しない。
  if (story.update(Math.min((now - last) / 1000, 1))) {
    ctx.render();
    renders++;
  }
  last = now;
});

story.scroll.refresh();
ctx.render();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
