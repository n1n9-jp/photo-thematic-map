/**
 * 本文カードの DOM を作り、大きな数値を数え上げる。
 *
 * 1つの場面（段階）の本文は、複数の小さなカードに分ける。最初のカードは「場面の番号・見出し・大きな数値」、
 * つづくカードは段落を1つずつ。カードは「拍」(`.story-beat`)の中に1枚ずつ入り、スクロールで画面に入ると、
 * 決まった位置（`story.css` の `top`）で止まって読まれ、そのあと外れていく。拍と拍のあいだは何も出ず、3D の画面が見える。
 * 場面の進み具合は、場面のセクション全体（すべての拍）を通して数える。
 *
 * 画面の下寄りに並ぶ配置（`--story-layout: bottom`）では、カードは止まっている間の終わりに、その場で薄くなって消える
 * （画面の上半分へ押し上げられて重なることがない）。左の列の配置（`side`）では、そのまま上へ流れて出ていく。
 *
 * 数え上げは、数値の要素が画面に入ったときに始め、`COUNT_DURATION_MS` かけて最終値まで上がる。
 * 通り過ぎた段階は最終値、まだの段階で画面の外にあるものは 0 に戻す（もう一度入ったら数え直す）。
 */
import { COUNT_DURATION_MS, countValue, formatCount } from './countUp';
import { clamp01 } from './cameraPath';
import type { StoryLayout } from './layout';
import { prefersReducedMotion } from './motion';
import type { StoryStage, StoryState } from './types';

/** カードの配置の測定結果。 */
export interface StoryCardsLayout {
  layout: StoryLayout;
  /** すべてのカードの右端の x の最大(px)。 */
  columnRight: number;
  /** すべてのカードの「止まる位置」の上端 y の最小(px)。いちばん高いカードの上端。 */
  coverTop: number;
}

export interface StoryCards {
  /** 段階ごとのセクション（`createStoryScroll` に渡す）。 */
  sections: HTMLElement[];
  /** 現在の状態を表示へ反映する。 */
  update(state: StoryState): void;
  /**
   * カードの高さを測って、拍の CSS 変数 `--story-card-h` に書く（カードを画面の下端に揃えるため）。
   * レイアウトが変わったとき（リサイズ・フォントの読み込み後）に呼ぶ。位置を求める前にも呼ばれる。
   */
  measure(): void;
  /**
   * セクション `section` の最後のカードが止まり終える（カメラが次の場面へ動き出してよい）スクロール位置(px)。
   * 最後のカードの「拍」の下端が、カードの下端に届く位置。
   */
  holdScrollY(section: HTMLElement): number;
  /** カードの配置の測定結果。 */
  layoutInfo(): StoryCardsLayout;
  dispose(): void;
}

/** 止まり終えるまでの残りのスクロール量がこの値以下になると、カードは薄くなりはじめる(px)。 */
const FADE_DISTANCE_PX = 96;
/** この透明度以下のカードは、ポインタを受けない（見えないカードが背後の操作を邪魔しない）。 */
const GONE_ALPHA = 0.05;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 場面の番号（「02 / 08」）と、物語の中の位置を示す目盛り（場面の数だけ並ぶ区切り。通り過ぎた場面・現在の場面・まだの場面）。
 * 文字は「02 / 08」のまま（目盛りは支援技術から隠す）。
 */
function indexNode(i: number, total: number): HTMLElement {
  const node = el('p', 'story-card__index');
  const pad = (k: number): string => String(k).padStart(2, '0');
  const label = el('span', 'story-card__index-label');
  label.append(el('span', 'story-card__index-current', pad(i + 1)), el('span', 'story-card__index-total', ` / ${pad(total)}`));
  const track = el('span', 'story-progress');
  track.setAttribute('aria-hidden', 'true');
  for (let k = 0; k < total; k++) {
    const seg = el('span', 'story-progress__step');
    seg.dataset.state = k < i ? 'done' : k === i ? 'current' : 'todo';
    track.append(seg);
  }
  node.append(label, track);
  return node;
}

interface StatSlot {
  node: HTMLElement;
  value: number;
  digits: number;
  /** idle: 0 のまま / running: 数え上げ中 / done: 最終値。 */
  phase: 'idle' | 'running' | 'done';
  startedAt: number;
  visible: boolean;
  shown: string;
}

let idSeq = 0;

export function renderStoryCards(
  root: HTMLElement,
  stages: readonly StoryStage[],
  options: { reducedMotion?: () => boolean } = {},
): StoryCards {
  const reduced = options.reducedMotion ?? prefersReducedMotion;
  root.classList.add('story');
  root.replaceChildren();
  const prefix = `story-${++idSeq}`;

  const slots: (StatSlot | null)[] = [];
  /** 拍ごとの（拍・カード）。 */
  const beats: { beat: HTMLElement; card: HTMLElement }[] = [];
  /** セクションごとの、最後の拍。 */
  const lastBeat = new Map<HTMLElement, { beat: HTMLElement; card: HTMLElement }>();

  const addBeat = (section: HTMLElement, card: HTMLElement): void => {
    const beat = el('div', 'story-beat');
    beat.append(card, el('div', 'story-beat__dwell'));
    section.append(beat);
    const entry = { beat, card };
    beats.push(entry);
    lastBeat.set(section, entry);
  };

  const sections = stages.map((stage, i) => {
    const section = el('section', 'story-step');
    section.dataset.stageId = stage.id;
    section.dataset.stageIndex = String(i);
    if (i === stages.length - 1) section.classList.add('story-step--last');
    const headingId = `${prefix}-heading-${i}`;
    section.setAttribute('aria-labelledby', headingId);

    // 最初のカード: 場面の番号・見出し・大きな数値
    const intro = el('div', 'story-card story-card--intro');
    intro.append(indexNode(i, stages.length));
    const heading = el('h2', 'story-card__heading', stage.text.heading);
    heading.id = headingId;
    intro.append(heading);

    const stat = stage.text.stat;
    if (stat) {
      const box = el('p', 'story-stat');
      const digits = stat.fractionDigits ?? 0;
      // 数字の枠: 最終値の幅を見えない文字で確保し、数え上げの途中の値を右に揃えて重ねる（桁が変わっても幅が揺れない）。
      const figure = el('span', 'story-stat__figure');
      figure.setAttribute('aria-hidden', 'true');
      const value = el('span', 'story-stat__value', formatCount(0, digits));
      figure.append(el('span', 'story-stat__sizer', formatCount(stat.value, digits)), value);
      // 支援技術には、数え上げ途中の値ではなく最終値だけを読ませる。
      const finalText = el('span', 'story-visually-hidden', `${formatCount(stat.value, digits)}${stat.unit ?? ''}`);
      box.append(figure, finalText);
      if (stat.unit) {
        const unit = el('span', 'story-stat__unit', stat.unit);
        unit.setAttribute('aria-hidden', 'true');
        box.append(unit);
      }
      if (stat.label) box.append(el('span', 'story-stat__label', stat.label));
      intro.append(box);
      slots.push({
        node: value,
        value: stat.value,
        digits,
        phase: 'idle',
        startedAt: 0,
        visible: false,
        shown: formatCount(0, digits),
      });
    } else {
      slots.push(null);
    }
    addBeat(section, intro);

    // つづくカード: 段落を1つずつ
    for (const paragraph of stage.text.paragraphs) {
      const card = el('div', 'story-card story-card--body');
      card.append(el('p', 'story-card__body', paragraph));
      addBeat(section, card);
    }

    root.append(section);
    return section;
  });

  let current: StoryState = { stage: 0, progress: 0, position: 0 };
  let raf = 0;
  let disposed = false;

  function show(slot: StatSlot, value: number): void {
    const text = formatCount(value, slot.digits);
    if (slot.shown !== text) {
      slot.shown = text;
      slot.node.textContent = text;
    }
  }

  function tick(): void {
    raf = 0;
    if (disposed) return;
    const now = performance.now();
    let running = false;
    for (const slot of slots) {
      if (!slot || slot.phase !== 'running') continue;
      const f = (now - slot.startedAt) / COUNT_DURATION_MS;
      if (f >= 1) slot.phase = 'done';
      else running = true;
      show(slot, countValue(slot.value, f, { fractionDigits: slot.digits }));
    }
    if (running) raf = requestAnimationFrame(tick);
  }

  function start(slot: StatSlot): void {
    if (slot.phase !== 'idle') return;
    if (reduced()) {
      slot.phase = 'done';
      show(slot, slot.value);
      return;
    }
    slot.phase = 'running';
    slot.startedAt = performance.now();
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function sync(): void {
    const instant = reduced();
    slots.forEach((slot, i) => {
      if (!slot) return;
      if (i < current.stage || (instant && i <= current.stage)) {
        // 通り過ぎた段階は最終値。
        slot.phase = 'done';
        show(slot, slot.value);
      } else if (i > current.stage && !slot.visible) {
        // まだの段階で画面の外にあれば 0 に戻し、次に入ったときに数え直す。
        slot.phase = 'idle';
        show(slot, 0);
      } else if (slot.visible) {
        start(slot);
      }
    });
  }

  // --- カードの配置（高さの測定・薄くする・止まる位置の問い合わせ） ---

  function layoutKind(): StoryLayout {
    return getComputedStyle(root).getPropertyValue('--story-layout').trim() === 'side' ? 'side' : 'bottom';
  }

  function stickyTop(card: HTMLElement): number {
    const top = Number.parseFloat(getComputedStyle(card).top);
    return Number.isFinite(top) ? top : 0;
  }

  const measuredHeights: number[] = [];
  function measure(): void {
    beats.forEach(({ beat, card }, k) => {
      const h = card.offsetHeight;
      if (measuredHeights[k] === h) return;
      measuredHeights[k] = h;
      beat.style.setProperty('--story-card-h', `${h}px`);
    });
  }

  /** 画面の下寄りの配置で、止まる位置の終わりに近づいたカードを薄くする。 */
  function updateFade(): void {
    const bottom = layoutKind() === 'bottom';
    const viewport = window.innerHeight;
    for (const { beat, card } of beats) {
      let alpha = 1;
      if (bottom) {
        const b = beat.getBoundingClientRect();
        if (b.bottom > -viewport && b.top < viewport * 2) {
          // 拍の下端とカードの下端の差 = 止まっていられる残りのスクロール量
          alpha = clamp01((b.bottom - card.getBoundingClientRect().bottom) / FADE_DISTANCE_PX);
        }
      }
      const text = alpha >= 1 ? '' : alpha.toFixed(3);
      if (card.style.getPropertyValue('--story-alpha') !== text) {
        if (text) card.style.setProperty('--story-alpha', text);
        else card.style.removeProperty('--story-alpha');
      }
      card.classList.toggle('story-card--gone', alpha <= GONE_ALPHA);
    }
  }

  let fadeRaf = 0;
  function scheduleFade(): void {
    if (fadeRaf || disposed) return;
    fadeRaf = requestAnimationFrame(() => {
      fadeRaf = 0;
      if (!disposed) updateFade();
    });
  }
  window.addEventListener('scroll', scheduleFade, { passive: true });
  window.addEventListener('resize', scheduleFade);

  // カードの大きさが変わったら（リサイズ・フォントの読み込み）高さを測り直す。
  const sizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          measure();
          scheduleFade();
        })
      : null;
  for (const { card } of beats) sizeObserver?.observe(card);
  measure();
  updateFade();

  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const slot = slots.find((s) => s?.node === entry.target);
            if (slot) slot.visible = entry.isIntersecting;
          }
          sync();
        })
      : null;
  for (const slot of slots) {
    if (!slot) continue;
    if (observer) observer.observe(slot.node);
    else slot.visible = true; // 判定できない環境では、段階に入ったら数え上げる。
  }

  return {
    sections,
    measure,
    holdScrollY(section) {
      measure();
      const entry = lastBeat.get(section);
      if (!entry) return section.getBoundingClientRect().bottom + window.scrollY;
      const beatBottom = entry.beat.getBoundingClientRect().bottom + window.scrollY;
      // 拍の下端がカードの下端に届く（カードが押し上げられはじめる）スクロール位置。
      return beatBottom - (stickyTop(entry.card) + entry.card.offsetHeight);
    },
    layoutInfo() {
      measure();
      let columnRight = 0;
      let coverTop = Number.POSITIVE_INFINITY;
      for (const { card } of beats) {
        columnRight = Math.max(columnRight, card.getBoundingClientRect().right);
        coverTop = Math.min(coverTop, stickyTop(card));
      }
      return { layout: layoutKind(), columnRight, coverTop: Number.isFinite(coverTop) ? coverTop : window.innerHeight };
    },
    update(state) {
      current = state;
      scheduleFade();
      if (!observer) {
        slots.forEach((slot, i) => {
          if (slot) slot.visible = i <= state.stage;
        });
      }
      sync();
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      sizeObserver?.disconnect();
      window.removeEventListener('scroll', scheduleFade);
      window.removeEventListener('resize', scheduleFade);
      if (raf) cancelAnimationFrame(raf);
      if (fadeRaf) cancelAnimationFrame(fadeRaf);
    },
  };
}
