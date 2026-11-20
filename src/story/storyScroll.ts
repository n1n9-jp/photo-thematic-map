/**
 * スクロールの制御。段階ごとの本文セクションに ScrollTrigger を張り、
 * 現在の段階の番号と段階内の進捗をリスナーへ通知する。
 *
 * 段階 i の進捗は、セクションの上端が画面中央に来た時点を 0、下端が画面中央に来た時点を 1 とする
 * （最初の段階だけ、上端の代わりにスクロール位置 0 を 0 とし、最後の段階だけ、下端の代わりにページ末尾を 1 とする）。
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { StoryStage, StoryState } from './types';

gsap.registerPlugin(ScrollTrigger);

export type StoryListener = (state: StoryState) => void;

export interface StoryScroll {
  getState(): StoryState;
  /** リスナーを登録する。登録時に現在の状態で1回呼ばれる。戻り値で登録解除。 */
  subscribe(listener: StoryListener): () => void;
  /** レイアウトが変わったあとに位置を計算し直す。 */
  refresh(): void;
  dispose(): void;
}

export function createStoryScroll(
  sections: readonly HTMLElement[],
  stages: readonly StoryStage[],
): StoryScroll {
  if (sections.length !== stages.length) throw new Error('sections と stages の数が違います');
  const last = sections.length - 1;
  const listeners = new Set<StoryListener>();
  let state: StoryState = { stage: 0, progress: 0, position: 0 };

  // ScrollTrigger.create は作成中にコールバックを同期で呼ぶことがあるため、全部作り終えるまで通知しない。
  const triggers: ScrollTrigger[] = [];
  let ready = false;
  sections.forEach((el, i) => {
    triggers.push(
      ScrollTrigger.create({
        trigger: el,
        // 最初のセクションは上端がページ先頭にあり「上端が画面中央」がスクロール位置 0 より手前になるため、0 から始める。
        start: i === 0 ? 0 : 'top center',
        end: i === last ? 'max' : 'bottom center',
        onUpdate: () => recompute(),
      }),
    );
  });
  ready = true;

  function compute(): StoryState {
    // 進捗が 0 より大きい最後のセクションが現在の段階。
    let stage = 0;
    for (let i = triggers.length - 1; i >= 0; i--) {
      if ((triggers[i]?.progress ?? 0) > 0) {
        stage = i;
        break;
      }
    }
    const progress = triggers[stage]?.progress ?? 0;
    return { stage, progress, position: stage + progress };
  }

  function recompute(): void {
    if (!ready) return;
    const next = compute();
    const prev = state;
    if (next.stage === prev.stage && next.progress === prev.progress) return;
    state = next;

    if (next.stage !== prev.stage) {
      // 離れた段階へ、進んで離れたなら 1、戻って離れたなら 0 を渡して締める。
      notifyStage(prev.stage, next.stage > prev.stage ? 1 : 0);
    }
    notifyStage(next.stage, next.progress);
    for (const l of [...listeners]) l(state);
  }

  function notifyStage(index: number, progress: number): void {
    const stage = stages[index];
    stage?.onProgress?.(progress, { index, stage });
  }

  const onRefresh = (): void => recompute();
  ScrollTrigger.addEventListener('refresh', onRefresh);
  // 初期状態を確定させる（リロード時にスクロール位置が復元されている場合を含む）。
  state = compute();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    refresh() {
      ScrollTrigger.refresh();
      recompute();
    },
    dispose() {
      ScrollTrigger.removeEventListener('refresh', onRefresh);
      for (const t of triggers) t.kill();
      listeners.clear();
    },
  };
}
