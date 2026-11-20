/** OS の「視差効果を減らす」設定。MediaQueryList を1つだけ作り、change イベントで値を更新する。 */
let query: MediaQueryList | null = null;
let reduced = false;
const listeners = new Set<(reduced: boolean) => void>();

function ensureQuery(): void {
  if (query || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  query = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduced = query.matches;
  query.addEventListener('change', (e) => {
    reduced = e.matches;
    for (const l of [...listeners]) l(reduced);
  });
}

/** 「視差効果を減らす」が有効か。毎フレーム呼んでも MediaQueryList を作り直さない。 */
export function prefersReducedMotion(): boolean {
  ensureQuery();
  return reduced;
}

/** 設定が変わったときに呼ばれる。戻り値で登録解除。 */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  ensureQuery();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
