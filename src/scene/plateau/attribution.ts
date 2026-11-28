/** 画面の隅に出典を常時表示する小さな要素。 */
import '../../styles/tokens.css';

export const PLATEAU_ATTRIBUTION = '出典：国土交通省 Project PLATEAU（https://www.mlit.go.jp/plateau/）のデータを加工して作成';
export const GSI_ATTRIBUTION = '標高：国土地理院 標高タイル';
/** 確認ページの出典表示の既定の行（建物の PLATEAU と、地面の起伏の国土地理院 標高タイル）。 */
export function defaultAttributionLines(): string[] {
  return [PLATEAU_ATTRIBUTION, GSI_ATTRIBUTION];
}

export function addAttribution(parent: HTMLElement = document.body, lines: readonly string[] = defaultAttributionLines()): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ptm-attribution';
  el.setAttribute('role', 'contentinfo');
  Object.assign(el.style, {
    position: 'fixed',
    right: '8px',
    bottom: '6px',
    zIndex: '10',
    maxWidth: 'calc(100vw - 16px)',
    padding: '2px 6px',
    font: '11px/1.4 system-ui, sans-serif',
    color: '#222',
    background: 'rgba(255, 255, 255, 0.75)',
    borderRadius: '3px',
    pointerEvents: 'auto',
    textAlign: 'right',
  } satisfies Partial<CSSStyleDeclaration>);
  for (const line of lines) {
    const row = document.createElement('div');
    // URL 部分はリンクにする
    const m = /(https?:\/\/[^\s）)]+)/.exec(line);
    if (m && m.index !== undefined) {
      row.append(line.slice(0, m.index));
      const a = document.createElement('a');
      a.href = m[1] ?? '';
      a.textContent = m[1] ?? '';
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.color = 'inherit';
      row.append(a, line.slice(m.index + (m[1]?.length ?? 0)));
    } else {
      row.textContent = line;
    }
    el.append(row);
  }
  parent.append(el);
  return el;
}

/** 出典の1行を、文字列とリンクの並びで表す。 */
export type AttributionSegment = string | { text: string; href: string; external?: boolean };

/** 本編の出典表示（2行）。語ごとにリンクを付ける。国土地理院は地面の起伏に使う標高タイル。 */
export function siteAttributionLines(methodsHref = '#data-and-methods'): AttributionSegment[][] {
  return [
    [
      '出典：',
      { text: '国土交通省 PLATEAU', href: 'https://www.mlit.go.jp/plateau/' },
      '・',
      { text: '国土地理院', href: 'https://maps.gsi.go.jp/development/ichiran.html' },
      '・',
      { text: '国土数値情報', href: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html' },
      '・',
      { text: '東京都', href: 'https://www.tomin-anzen.metro.tokyo.lg.jp/kotsu/jitensha/houchi/0000001962' },
      'のデータを加工して作成',
    ],
    ['非公式の作品｜', { text: 'データと方法', href: methodsHref, external: false }],
  ];
}

const SITE_ATTRIBUTION_CSS = `
.ptm-site-attribution {
  position: fixed;
  left: max(8px, env(safe-area-inset-left));
  bottom: max(6px, env(safe-area-inset-bottom));
  z-index: 10;
  box-sizing: border-box;
  max-width: min(calc(100vw - 16px), 40rem);
  padding: var(--ptm-space-1) var(--ptm-space-3);
  font-family: var(--ptm-font-sans);
  font-size: var(--ptm-text-xs);
  line-height: var(--ptm-leading-snug);
  letter-spacing: var(--ptm-tracking-body);
  color: var(--ptm-ink-2);
  background: var(--ptm-surface);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border-radius: var(--ptm-radius-md);
  box-shadow: var(--ptm-shadow-1);
}
.ptm-site-attribution p { margin: 0; }
.ptm-site-attribution p + p { color: var(--ptm-ink-3); }
/* 幅が広い画面では、本文カードが左の列を流れるので、出典表示は右下に置く。 */
@media (min-width: 768px) {
  .ptm-site-attribution {
    left: auto;
    right: max(8px, env(safe-area-inset-right));
    text-align: right;
  }
}
.ptm-site-attribution a {
  position: relative;
  display: inline-block;
  /* 文字の上下に余白を取って高さ 24px 以上にし、見えない範囲（::after）で上下に広げて押せる高さを 44px にする */
  padding: var(--ptm-space-1) 1px;
  color: var(--ptm-ink-1);
  font-weight: var(--ptm-weight-medium);
  text-decoration: underline;
  text-decoration-color: var(--ptm-rule-strong);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  border-radius: var(--ptm-radius-sm);
  -webkit-tap-highlight-color: var(--ptm-accent-soft);
  transition: text-decoration-color var(--ptm-duration) var(--ptm-ease), color var(--ptm-duration) var(--ptm-ease);
}
.ptm-site-attribution a::after {
  content: '';
  position: absolute;
  inset: -10px 0;
}
/* hover の色は、ポインタで hover できる端末だけ（タッチ端末で押した後に色が残らないように）。 */
@media (hover: hover) {
  .ptm-site-attribution a:hover { text-decoration-color: currentColor; }
}
.ptm-site-attribution a:active { color: var(--ptm-accent-strong); }
/* フォーカスの輪は他の部品と同じ一重の表現。強制カラーでは影が消えるので、透明の輪郭線をシステムの色で描く。 */
.ptm-site-attribution a:focus-visible { outline: 2px solid transparent; outline-offset: 1px; box-shadow: var(--ptm-focus-ring); }
@media (forced-colors: active) {
  .ptm-site-attribution { border: var(--ptm-hairline) solid CanvasText; }
  .ptm-site-attribution a:focus-visible { outline-color: Highlight; }
}
`;

/**
 * 本編用の出典表示。画面の下端に常時表示する（幅が広い画面では右下。左の列を本文カードが流れるため）。行は `siteAttributionLines()` の形で渡す。
 * 要素の高さを CSS 変数 `--ptm-attribution-height` として document に書き出す（本文カードや「地図を動かす」ボタンが避けるため）。
 */
export function addSiteAttribution(
  parent: HTMLElement = document.body,
  lines: readonly (readonly AttributionSegment[])[] = siteAttributionLines(),
): { element: HTMLElement; remove(): void } {
  const style = document.createElement('style');
  style.textContent = SITE_ATTRIBUTION_CSS;
  document.head.append(style);

  const el = document.createElement('footer');
  el.className = 'ptm-attribution ptm-site-attribution';
  el.setAttribute('aria-label', '出典');
  for (const line of lines) {
    const row = document.createElement('p');
    for (const seg of line) {
      if (typeof seg === 'string') {
        row.append(seg);
        continue;
      }
      const a = document.createElement('a');
      a.href = seg.href;
      a.textContent = seg.text;
      if (seg.external ?? true) {
        a.target = '_blank';
        a.rel = 'noopener';
      }
      row.append(a);
    }
    el.append(row);
  }
  parent.append(el);

  const root = document.documentElement;
  const publish = (): void => root.style.setProperty('--ptm-attribution-height', `${el.offsetHeight}px`);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
  observer?.observe(el);
  publish();

  return {
    element: el,
    remove() {
      observer?.disconnect();
      root.style.removeProperty('--ptm-attribution-height');
      el.remove();
      style.remove();
    },
  };
}
