/** 本文カードの DOM を作り、段階内の進捗に合わせて大きな数値を数え上げる。 */
import { countValue, formatCount } from './countUp';
import { prefersReducedMotion } from './motion';
import type { StoryStage, StoryState } from './types';

export interface StoryCards {
  /** 段階ごとのセクション（`createStoryScroll` に渡す）。 */
  sections: HTMLElement[];
  /** 現在の状態を表示へ反映する。 */
  update(state: StoryState): void;
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

export function renderStoryCards(
  root: HTMLElement,
  stages: readonly StoryStage[],
  options: { reducedMotion?: () => boolean } = {},
): StoryCards {
  const reduced = options.reducedMotion ?? prefersReducedMotion;
  root.classList.add('story');
  root.replaceChildren();

  const statValues: (HTMLElement | null)[] = [];
  const sections = stages.map((stage, i) => {
    const section = el('section', 'story-step');
    section.dataset.stageId = stage.id;
    section.dataset.stageIndex = String(i);
    if (i === stages.length - 1) section.classList.add('story-step--last');

    const card = el('article', 'story-card');
    card.append(el('p', 'story-card__index', `${String(i + 1).padStart(2, '0')} / ${String(stages.length).padStart(2, '0')}`));
    card.append(el('h2', 'story-card__heading', stage.text.heading));
    for (const paragraph of stage.text.paragraphs) {
      card.append(el('p', 'story-card__body', paragraph));
    }

    const stat = stage.text.stat;
    if (stat) {
      const box = el('p', 'story-stat');
      const value = el('span', 'story-stat__value', formatCount(0));
      value.setAttribute('aria-hidden', 'true');
      // 支援技術には、数え上げ途中の値ではなく最終値だけを読ませる。
      const finalText = el('span', 'story-visually-hidden', `${formatCount(stat.value)}${stat.unit ?? ''}`);
      box.append(value, finalText);
      if (stat.unit) {
        const unit = el('span', 'story-stat__unit', stat.unit);
        unit.setAttribute('aria-hidden', 'true');
        box.append(unit);
      }
      if (stat.label) box.append(el('span', 'story-stat__label', stat.label));
      card.append(box);
      statValues.push(value);
    } else {
      statValues.push(null);
    }

    section.append(card);
    root.append(section);
    return section;
  });

  const shown: string[] = statValues.map((v) => v?.textContent ?? '');

  return {
    sections,
    update(state) {
      const instant = reduced();
      stages.forEach((stage, i) => {
        const node = statValues[i];
        const stat = stage.text.stat;
        if (!node || !stat) return;
        // 通り過ぎた段階は最終値、まだの段階は 0。
        const progress = i < state.stage ? 1 : i > state.stage ? 0 : state.progress;
        const text = formatCount(countValue(stat.value, progress, { instant: instant && i <= state.stage }));
        if (shown[i] !== text) {
          shown[i] = text;
          node.textContent = text;
        }
      });
    },
  };
}
