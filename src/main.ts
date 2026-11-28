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

// URL のページ内リンク（例: #data-and-methods）で開いたときは、本文を組んでレイアウトを計算し直した後に、その要素へ移る。
// 読み込みの間に読者が自分でスクロールし始めたら、移らない。
const hashTarget = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '';
let userScrolled = false;
const markUserScroll = (): void => {
  userScrolled = true;
};
const userScrollEvents = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
for (const type of userScrollEvents) window.addEventListener(type, markUserScroll, { passive: true, once: true });

const app = await createApp({ container, storyRoot, modules: SCENE_MODULES, depth, buildingErrorTarget, pauseWhenCovered: methods });
window.__MAIN__ = app.debug;
// 確認用（コンソールから街並みのタイルなどを調べる）
(window as unknown as { __PTM_APP__: unknown }).__PTM_APP__ = app;

for (const type of userScrollEvents) window.removeEventListener(type, markUserScroll);
const hashElement = hashTarget ? document.getElementById(hashTarget) : null;
if (hashElement && !userScrolled) hashElement.scrollIntoView({ behavior: 'instant', block: 'start' });

await app.firstFrame;
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
