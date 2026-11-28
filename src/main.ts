/**
 * 本編。PLATEAU の街並みとスクロール連動の語りを組み、場面ごとの 3D の中身（今は仮の表示）を差し込む。
 * `?depth=standard|reversed|logarithmic` で深度バッファの方式、`?error=` で建物の画面上の許容誤差(px)を切り替えられる（確認用）。
 */
import { createApp } from './app/createApp';
import { mountMethodsSection } from './app/methods/render';
import { SCENE_MODULES } from './app/modules';
import type { DepthMode } from './scene/createScene';
import { mountCover } from './story/cover';

declare global {
  interface Window {
    /** 最初のフレームを描画し終えたら true。E2E テストが待機に使う。 */
    __APP_READY__?: boolean;
  }
}

const container = document.getElementById('app');
const storyRoot = document.getElementById('story');
if (!container || !storyRoot) throw new Error('#app / #story が見つかりません');

// 表紙（index.html に静的に書いてある）。スクロールで上へ抜けるときに薄くする。
const cover = document.querySelector<HTMLElement>('.ptm-cover');
if (cover) mountCover(cover);

// 「データと方法」の節は、3D の準備を待たずに先に組む（出典表示のリンクで、読み込み中でも移動できる）
const methods = mountMethodsSection();

const depthParam = new URLSearchParams(location.search).get('depth');
const depth: DepthMode | undefined =
  depthParam === 'standard' || depthParam === 'reversed' || depthParam === 'logarithmic' ? depthParam : undefined;

const errorParam = Number(new URLSearchParams(location.search).get('error'));
const buildingErrorTarget = Number.isFinite(errorParam) && errorParam > 0 ? errorParam : undefined;

const app = await createApp({ container, storyRoot, modules: SCENE_MODULES, depth, buildingErrorTarget, pauseWhenCovered: methods });
window.__MAIN__ = app.debug;
// 確認用（コンソールから街並みのタイルなどを調べる）
(window as unknown as { __PTM_APP__: unknown }).__PTM_APP__ = app;

await app.firstFrame;
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
