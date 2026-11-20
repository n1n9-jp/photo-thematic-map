/**
 * 本編。PLATEAU の街並みとスクロール連動の語りを組み、場面ごとの 3D の中身（今は仮の表示）を差し込む。
 * `?depth=standard|reversed|logarithmic` で深度バッファの方式を切り替えられる（確認用）。
 */
import { createApp } from './app/createApp';
import { SCENE_MODULES } from './app/modules';
import type { DepthMode } from './scene/createScene';

declare global {
  interface Window {
    /** 最初のフレームを描画し終えたら true。E2E テストが待機に使う。 */
    __APP_READY__?: boolean;
  }
}

const container = document.getElementById('app');
const storyRoot = document.getElementById('story');
if (!container || !storyRoot) throw new Error('#app / #story が見つかりません');

const depthParam = new URLSearchParams(location.search).get('depth');
const depth: DepthMode | undefined =
  depthParam === 'standard' || depthParam === 'reversed' || depthParam === 'logarithmic' ? depthParam : undefined;

const app = await createApp({ container, storyRoot, modules: SCENE_MODULES, depth });
window.__MAIN__ = app.debug;

await app.firstFrame;
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
