/**
 * 要素が画面の上端に達して、画面いっぱいを覆っている間（その後ろの 3D の画面が見えない間）を知らせる。
 * 「データと方法」の節に入ったら 3D の描画を止めるのに使う。
 * 要素の上端が画面の上端より上（top <= 0）にあれば覆っているとする（要素は画面より背が高く、不透明）。
 */
export function watchCover(el: HTMLElement, onChange: (covered: boolean) => void): () => void {
  let covered: boolean | null = null;
  const check = (): void => {
    const next = el.getBoundingClientRect().top <= 0;
    if (next === covered) return;
    covered = next;
    onChange(next);
  };
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check, { passive: true });
  check();
  return () => {
    window.removeEventListener('scroll', check);
    window.removeEventListener('resize', check);
  };
}
