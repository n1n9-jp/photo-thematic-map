/**
 * 本文カードの DOM を作り、大きな数値を数え上げる。
 *
 * 数え上げは、数値の要素が画面に入ったときに始め、`COUNT_DURATION_MS` かけて最終値まで上がる。
 * 通り過ぎた段階は最終値、まだの段階で画面の外にあるものは 0 に戻す（もう一度入ったら数え直す）。
 */
import { COUNT_DURATION_MS, countValue, formatCount } from './countUp';
import { prefersReducedMotion } from './motion';
import type { StoryStage, StoryState } from './types';

export interface StoryCards {
  /** 段階ごとのセクション（`createStoryScroll` に渡す）。 */
  sections: HTMLElement[];
  /** 現在の状態を表示へ反映する。 */
  update(state: StoryState): void;
  dispose(): void;
}

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
  const sections = stages.map((stage, i) => {
    const section = el('section', 'story-step');
    section.dataset.stageId = stage.id;
    section.dataset.stageIndex = String(i);
    if (i === stages.length - 1) section.classList.add('story-step--last');

    const card = el('article', 'story-card');
    const headingId = `${prefix}-heading-${i}`;
    card.setAttribute('aria-labelledby', headingId);
    card.append(el('p', 'story-card__index', `${String(i + 1).padStart(2, '0')} / ${String(stages.length).padStart(2, '0')}`));
    const heading = el('h2', 'story-card__heading', stage.text.heading);
    heading.id = headingId;
    card.append(heading);
    for (const paragraph of stage.text.paragraphs) {
      card.append(el('p', 'story-card__body', paragraph));
    }

    const stat = stage.text.stat;
    if (stat) {
      const box = el('p', 'story-stat');
      const digits = stat.fractionDigits ?? 0;
      const value = el('span', 'story-stat__value', formatCount(0, digits));
      value.setAttribute('aria-hidden', 'true');
      // 支援技術には、数え上げ途中の値ではなく最終値だけを読ませる。
      const finalText = el('span', 'story-visually-hidden', `${formatCount(stat.value, digits)}${stat.unit ?? ''}`);
      box.append(value, finalText);
      if (stat.unit) {
        const unit = el('span', 'story-stat__unit', stat.unit);
        unit.setAttribute('aria-hidden', 'true');
        box.append(unit);
      }
      if (stat.label) box.append(el('span', 'story-stat__label', stat.label));
      card.append(box);
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

    section.append(card);
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
    update(state) {
      current = state;
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
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
