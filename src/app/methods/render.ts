/** 「データと方法」の節（`MethodsModel`）を DOM にする。見出しは h2（index.html にある）→ h3（項目）→ h4（項目の中の小見出し）。 */
import './methods.css';
import { buildMethodsModel, METHODS_HEADING_ID, METHODS_SECTION_ID, type Block, type Inline, type MethodsModel } from './content';

function inlineNodes(parts: readonly Inline[]): Node[] {
  return parts.map((x) => {
    if (typeof x === 'string') return document.createTextNode(x);
    if ('strong' in x) {
      const el = document.createElement('strong');
      el.textContent = x.strong;
      return el;
    }
    const a = document.createElement('a');
    a.href = x.href;
    a.textContent = x.text;
    if (!x.href.startsWith('#')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  });
}

function blockNode(b: Block): HTMLElement {
  if (b.kind === 'h4') {
    const h = document.createElement('h4');
    h.id = `methods-${b.id}`;
    h.textContent = b.text;
    return h;
  }
  if (b.kind === 'p') {
    const el = document.createElement('p');
    el.append(...inlineNodes(b.content));
    return el;
  }
  const list = document.createElement('ul');
  for (const item of b.items) {
    const li = document.createElement('li');
    li.append(...inlineNodes(item));
    list.append(li);
  }
  return list;
}

export function renderMethods(root: HTMLElement, model: MethodsModel = buildMethodsModel()): void {
  const frag = document.createDocumentFragment();

  const lead = document.createElement('p');
  lead.className = 'methods__lead';
  lead.append(...inlineNodes(model.lead));
  frag.append(lead);

  // この節の項目への目次
  const nav = document.createElement('nav');
  nav.className = 'methods__toc';
  nav.setAttribute('aria-label', 'この節の項目');
  const toc = document.createElement('ul');
  for (const s of model.sections) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#methods-${s.id}`;
    a.textContent = s.heading;
    li.append(a);
    toc.append(li);
  }
  nav.append(toc);
  frag.append(nav);

  for (const s of model.sections) {
    const section = document.createElement('section');
    section.className = 'methods__item';
    const h3 = document.createElement('h3');
    h3.id = `methods-${s.id}`;
    h3.textContent = s.heading;
    section.append(h3);
    for (const b of s.blocks) section.append(blockNode(b));
    frag.append(section);
  }

  const back = document.createElement('p');
  back.className = 'methods__back';
  const a = document.createElement('a');
  a.href = model.backToTop.href;
  a.textContent = model.backToTop.text;
  back.append(a);
  frag.append(back);

  root.append(frag);
}

/** index.html の節（`#data-and-methods`）に中身を入れる。見出し（h2）は index.html にある。 */
export function mountMethodsSection(): HTMLElement {
  const section = document.getElementById(METHODS_SECTION_ID);
  if (!section) throw new Error(`#${METHODS_SECTION_ID} が見つかりません`);
  if (!document.getElementById(METHODS_HEADING_ID)) throw new Error(`#${METHODS_HEADING_ID} が見つかりません`);
  // 準備中の表示などの、見出し以外の中身を置き換える
  for (const child of [...section.children]) if (child.id !== METHODS_HEADING_ID) child.remove();
  renderMethods(section);
  return section;
}
