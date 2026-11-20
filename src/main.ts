import { createScene } from './scene/createScene';

declare global {
  interface Window {
    /** 最初のフレームを描画し終えたら true。E2E テストが待機に使う。 */
    __APP_READY__?: boolean;
  }
}

const container = document.getElementById('app');
if (!container) throw new Error('#app が見つかりません');

const ctx = createScene(container);
ctx.renderer.setAnimationLoop(ctx.render);

// 最初のフレームが描画されてから ready にする
ctx.render();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
