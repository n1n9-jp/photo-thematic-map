/** 山の計算が場面に間に合わなかったときの小さな表示（画面の上の中央）。 */
import '../../styles/tokens.css';
const CSS = `
.ptm-pile-loading {
  position: fixed;
  top: max(12px, env(safe-area-inset-top));
  left: 50%;
  z-index: 10;
  transform: translateX(-50%);
  padding: var(--ptm-space-2) var(--ptm-space-4);
  font-family: var(--ptm-font-sans);
  font-size: var(--ptm-text-sm);
  line-height: var(--ptm-leading-snug);
  letter-spacing: var(--ptm-tracking-body);
  font-variant-numeric: tabular-nums;
  color: var(--ptm-ink-1);
  background: var(--ptm-surface);
  border-radius: var(--ptm-radius-pill);
  box-shadow: var(--ptm-shadow-1);
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.ptm-pile-loading[data-state='idle'] { opacity: 0; }
`;

export interface PileLoadingBadge {
  element: HTMLElement;
  set(loading: boolean, fraction: number): void;
  dispose(): void;
}

export function createPileLoadingBadge(parent: HTMLElement = document.body): PileLoadingBadge {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.className = 'ptm-pile-loading';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.dataset.state = 'idle';
  parent.append(el);
  return {
    element: el,
    set(loading, fraction) {
      el.dataset.state = loading ? 'loading' : 'idle';
      if (loading) el.textContent = `自転車の山を計算しています（${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%）`;
    },
    dispose() {
      el.remove();
      style.remove();
    },
  };
}
