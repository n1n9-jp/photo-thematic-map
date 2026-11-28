/**
 * 表紙（index.html の `.ptm-cover`）。表紙そのものは静的な HTML と CSS（cover.css）で、JavaScript を待たずに出る。
 * ここでは、スクロールで上へ抜けていく表紙のパネルを、右上の読み込みの表示と横に重なる配置（スマートフォンの縦向き）では、
 * その表示に届く前に薄くして消す。
 * 薄くする量はスクロール位置だけで決まる（時間で動くアニメーションはない）。
 */
import { clamp01 } from './cameraPath';

/** パネルを薄くしていくスクロール量(px)。 */
const FADE_DISTANCE_PX = 96;
/** 画面の上端に固定された表示と、パネルのあいだに空ける距離(px)。 */
const GAP_PX = 8;
/** 画面の上端に固定され、パネルが重ならないようにする表示。 */
const OBSTACLES = '.ptm-loading';
/** この透明度以下のパネルは、ポインタを受けない。 */
const GONE_ALPHA = 0.05;

export interface Cover {
  element: HTMLElement;
  dispose(): void;
}

export function mountCover(element: HTMLElement): Cover {
  const panel = element.querySelector<HTMLElement>('.ptm-cover__panel') ?? element;
  let raf = 0;
  let disposed = false;

  /**
   * パネルと横の範囲が重なる、画面の上端に固定された表示（右上の読み込みの表示）の下端(px)。なければ null。
   * 読み込みの表示は読み込みが終わると透明になるが、また出ることがあるので、見えていなくても避ける。
   */
  function fixedTopObstacle(): number | null {
    const p = panel.getBoundingClientRect();
    let bottom: number | null = null;
    for (const el of document.querySelectorAll<HTMLElement>(OBSTACLES)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.right <= p.left || r.left >= p.right) continue;
      bottom = Math.max(bottom ?? 0, r.bottom);
    }
    return bottom;
  }

  function update(): void {
    raf = 0;
    if (disposed) return;
    // パネルが画面の上端の表示と横に重なるときだけ、その表示に届くまでの FADE_DISTANCE_PX のスクロールで薄くして消す
    // （パネルがはじめから表示のすぐ下にあるときは、スクロールしはじめから薄くする）。重ならなければ、そのまま上へ抜ける。
    const obstacle = fixedTopObstacle();
    let alpha = 1;
    if (obstacle !== null) {
      const restTop = panel.getBoundingClientRect().top + window.scrollY;
      const start = Math.max(0, restTop - (obstacle + GAP_PX) - FADE_DISTANCE_PX);
      alpha = 1 - clamp01((window.scrollY - start) / FADE_DISTANCE_PX);
    }
    const text = alpha >= 1 ? '' : alpha.toFixed(3);
    if (panel.style.getPropertyValue('--cover-alpha') !== text) {
      if (text) panel.style.setProperty('--cover-alpha', text);
      else panel.style.removeProperty('--cover-alpha');
    }
    element.classList.toggle('ptm-cover--gone', alpha <= GONE_ALPHA);
  }

  const schedule = (): void => {
    if (!raf && !disposed) raf = requestAnimationFrame(update);
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();

  return {
    element,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      panel.style.removeProperty('--cover-alpha');
      element.classList.remove('ptm-cover--gone');
    },
  };
}
