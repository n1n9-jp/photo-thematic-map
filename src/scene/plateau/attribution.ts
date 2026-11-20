/** 画面の隅に出典を常時表示する小さな要素。 */

export const PLATEAU_ATTRIBUTION = '出典：国土交通省 Project PLATEAU（https://www.mlit.go.jp/plateau/）のデータを加工して作成';
export const GSI_ATTRIBUTION = '標高：国土地理院 標高タイル';

export function addAttribution(parent: HTMLElement = document.body, lines: readonly string[] = [PLATEAU_ATTRIBUTION, GSI_ATTRIBUTION]): HTMLElement {
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

/** 本編の出典表示（2行）。語ごとにリンクを付ける。 */
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
  padding: 2px 8px;
  font: 12px/1.5 system-ui, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif;
  color: #1d1d1b;
  background: rgba(255, 255, 255, 0.82);
  border-radius: 4px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}
.ptm-site-attribution p { margin: 0; }
.ptm-site-attribution a {
  display: inline-block;
  /* タップしやすいよう、文字の上下に余白を取って高さ 24px 以上にする */
  padding: 4px 1px;
  color: #0b4f8a;
  text-decoration: underline;
  text-underline-offset: 2px;
  -webkit-tap-highlight-color: rgba(11, 79, 138, 0.2);
}
.ptm-site-attribution a:focus-visible { outline: 2px solid #f2c94c; outline-offset: 1px; }
`;

/**
 * 本編用の出典表示。画面の左下に常時表示する。行は `siteAttributionLines()` の形で渡す。
 * 要素の高さを CSS 変数 `--ptm-attribution-height` として document に書き出す（ほかの固定表示を避けるため）。
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
