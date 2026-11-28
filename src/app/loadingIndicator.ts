/** 画面の右上に出す、街並みの読み込み中の小さな表示。 */
import '../styles/tokens.css';
const CSS = `
.ptm-loading {
  position: fixed;
  top: max(12px, env(safe-area-inset-top));
  right: max(12px, env(safe-area-inset-right));
  z-index: 10;
  display: flex;
  align-items: center;
  gap: var(--ptm-space-2);
  padding: var(--ptm-space-2) var(--ptm-space-3);
  font-family: var(--ptm-font-sans);
  font-size: var(--ptm-text-xs);
  line-height: 1;
  letter-spacing: var(--ptm-tracking-body);
  color: var(--ptm-ink-2);
  background: var(--ptm-surface);
  border-radius: var(--ptm-radius-pill);
  box-shadow: var(--ptm-shadow-1);
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.ptm-loading[data-state='idle'] { opacity: 0; }
.ptm-loading__bar {
  position: relative;
  width: 32px;
  height: 4px;
  overflow: hidden;
  background: var(--ptm-rule);
  border-radius: 2px;
}
.ptm-loading__bar::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  background: var(--ptm-accent);
  border-radius: 2px;
  animation: ptm-loading-slide 1.1s ease-in-out infinite;
}
@keyframes ptm-loading-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) { .ptm-loading__bar::after { animation: none; width: 100%; opacity: 0.6; } }
`;

export interface LoadingIndicator {
  element: HTMLElement;
  /** 読み込み中か。detail は補足（例: 建物・地面）。 */
  set(loading: boolean, detail?: string): void;
  dispose(): void;
}

export function createLoadingIndicator(parent: HTMLElement = document.body): LoadingIndicator {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.className = 'ptm-loading';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.dataset.state = 'idle';
  const bar = document.createElement('span');
  bar.className = 'ptm-loading__bar';
  bar.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  el.append(bar, text);
  parent.append(el);
  let shown: string | null = null;
  return {
    element: el,
    set(loading, detail) {
      const label = loading ? `街並みを読み込み中${detail ? `（${detail}）` : ''}` : '';
      if (label === shown) return;
      shown = label;
      el.dataset.state = loading ? 'loading' : 'idle';
      text.textContent = loading ? label : '街並みを読み込みました';
    },
    dispose() {
      el.remove();
      style.remove();
    },
  };
}
