/** スクロール連動の語りの確認ページ。仮の本文で4段階（箱の接写 → 100m → 1km → 10km 上空）を定義する。 */
import {
  BoxGeometry,
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
      isFree(): boolean;
    };
  }
}

const container = document.getElementById('app');
const storyRoot = document.getElementById('story');
if (!container || !storyRoot) throw new Error('#app / #story が見つかりません');

const ctx = createScene(container);

// 土台の最小シーンは 1km 四方なので、10km の俯瞰に耐えるよう奥行きと地面を広げる。
ctx.camera.near = 2;
ctx.camera.far = 120_000;
ctx.camera.updateProjectionMatrix();
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

const story = createStory({ scene: ctx, stages, root: storyRoot });

window.__STORY__ = {
  getState: () => story.scroll.getState(),
  getCameraPosition: () => {
    const { x, y, z } = ctx.camera.position;
    return { x, y, z };
  },
  isFree: () => story.rig.isFree,
};

let last = performance.now();
ctx.renderer.setAnimationLoop((now: number) => {
  story.update(Math.min((now - last) / 1000, 1));
  last = now;
  ctx.render();
});

story.scroll.refresh();
ctx.render();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
