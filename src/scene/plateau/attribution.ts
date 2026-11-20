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
