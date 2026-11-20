/** OS の「視差効果を減らす」設定が有効か。呼ぶたびに現在の設定を読む。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
