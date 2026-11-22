/** 画面の隅に出典を常時表示する小さな要素。 */
import { orthoSourceFromUrl } from './orthoSource';
import type { OrthoSource } from './orthoSource';

export const PLATEAU_ATTRIBUTION = '出典：国土交通省 Project PLATEAU（https://www.mlit.go.jp/plateau/）のデータを加工して作成';
export const GSI_ATTRIBUTION = '標高：国土地理院 標高タイル';
/** 航空写真を国土地理院の写真に切り替えたとき（`?ortho=gsi`）の出典。 */
export const GSI_PHOTO_ATTRIBUTION = '航空写真：国土地理院 全国最新写真（シームレス）';

/** 確認ページの出典表示の既定の行。航空写真を国土地理院の写真に切り替えたときは、その行を足す。 */
export function defaultAttributionLines(ortho: OrthoSource = orthoSourceFromUrl()): string[] {
  return ortho === 'gsi' ? [PLATEAU_ATTRIBUTION, GSI_PHOTO_ATTRIBUTION, GSI_ATTRIBUTION] : [PLATEAU_ATTRIBUTION, GSI_ATTRIBUTION];
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

/**
 * 本編の出典表示（2行）。語ごとにリンクを付ける。
 * 航空写真を国土地理院の写真に切り替えたとき（`?ortho=gsi`）は、国土地理院の項に「写真」を明記する。
 */
export function siteAttributionLines(methodsHref = '#data-and-methods', ortho: OrthoSource = orthoSourceFromUrl()): AttributionSegment[][] {
  return [
    [
      '出典：',
      { text: '国土交通省 PLATEAU', href: 'https://www.mlit.go.jp/plateau/' },
      '・',
      ortho === 'gsi'
        ? { text: '国土地理院（全国最新写真（シームレス）・標高タイル）', href: 'https://maps.gsi.go.jp/development/ichiran.html' }
        : { text: '国土地理院', href: 'https://maps.gsi.go.jp/development/ichiran.html' },
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
/* 幅が広い画面では、本文カードが左の列を流れるので、出典表示は右下に置く。 */
@media (min-width: 768px) {
  .ptm-site-attribution {
    left: auto;
    right: max(8px, env(safe-area-inset-right));
    text-align: right;
  }
}
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
