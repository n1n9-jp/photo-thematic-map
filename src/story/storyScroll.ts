/**
 * スクロールの制御。段階ごとの本文セクションに ScrollTrigger を張り、
 * 現在の段階の番号と段階内の進捗をリスナーへ通知する。
 *
 * 段階 i の進捗は、セクションの上端が画面中央に来た時点を 0、下端が画面中央に来た時点を 1 とする
 * （セクションには、その段階の本文カードがすべて入っている。進捗はすべてのカードを通して数える）
 * （最初の段階だけ、上端が画面の上端に来た時点（本文がページ先頭から始まるならスクロール位置 0）を 0 とし、最後の段階だけ、下端の代わりにページ末尾を 1 とする）。
 *
 * リサイズや画面の回転でレイアウトが変わったときは、変わる前の位置（段階の番号と進捗）を記録しておき、
 * 計算し直したあとで同じ位置になるスクロール位置へ戻す。
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { clamp01 } from './cameraPath';
import type { StoryStage, StoryState } from './types';

gsap.registerPlugin(ScrollTrigger);

export type StoryListener = (state: StoryState) => void;

export interface StoryScroll {
  getState(): StoryState;
  /** リスナーを登録する。登録時に現在の状態で1回呼ばれる。戻り値で登録解除。 */
  subscribe(listener: StoryListener): () => void;
  /**
   * レイアウトが変わったあとに位置を計算し直す。読んでいた位置（段階と進捗）は保たれる。
   * 計算後、すべての段階の `onProgress` へ現在の状態を通知し直す。
   */
  refresh(): void;
  /**
   * 段階ごとの「カメラが止まっている割合」。段階 i の最後の本文カードが止まり終える進捗（`holdScrollY` を渡さなければ、カードの下端が画面の中央に来る進捗）。
   * これより先の進捗で、カメラはつぎの段階のキーフレームへ移る。レイアウトの計算し直しのたびに更新される。
   */
  getHolds(): readonly number[];
  /** 段階 stage の進捗 progress になるスクロール位置(px)。 */
  scrollYFor(stage: number, progress: number): number;
  dispose(): void;
}

export interface StoryScrollOptions {
  /** セクションの中で「本文カード」とみなす要素。既定は `.story-card`（無ければセクション自身）。 */
  cardOf?: (section: HTMLElement) => HTMLElement;
  /**
   * 段階のセクションについて、カメラが次の段階へ動き出してよいスクロール位置(px)。
   * 指定すると `cardOf` の代わりに使われる（カードが複数あり、止まる位置が画面の中央とは限らないとき）。
   */
  holdScrollY?: (section: HTMLElement, index: number) => number;
  /** カードの下端が画面中央に来る前でも、この割合を超えたら動き出す（カードが極端に長いときの上限）。既定 0.9。 */
  maxHold?: number;
}

/** 幅が変わらず高さだけが変わる、この割合未満のリサイズはアドレスバーの出入りとみなす（タッチ端末のみ）。 */
const MINOR_HEIGHT_CHANGE = 0.25;

export function createStoryScroll(
  sections: readonly HTMLElement[],
  stages: readonly StoryStage[],
  options: StoryScrollOptions = {},
): StoryScroll {
  if (sections.length !== stages.length) throw new Error('sections と stages の数が違います');
  const last = sections.length - 1;
  const listeners = new Set<StoryListener>();
  const cardOf = options.cardOf ?? ((s: HTMLElement) => s.querySelector<HTMLElement>('.story-card') ?? s);
  const maxHold = options.maxHold ?? 0.9;
  let state: StoryState = { stage: 0, progress: 0, position: 0 };
  let holds: number[] = sections.map(() => 0);

  // ScrollTrigger.create は作成中にコールバックを同期で呼ぶことがあるため、全部作り終えるまで通知しない。
  const triggers: ScrollTrigger[] = [];
  let ready = false;
  /** レイアウトの計算し直しの最中。この間はスクロール位置から状態を求めない。 */
  let frozen = false;
  /** 計算し直しの前に読んでいた位置。 */
  let saved: StoryState | null = null;
  /** 計算し直しの前のスクロール位置(px)。最初の段階が始まる前（表紙）を読んでいたときに使う。 */
  let savedScrollY = 0;
  let disposed = false;

  sections.forEach((el, i) => {
    triggers.push(
      ScrollTrigger.create({
        trigger: el,
        // 最初のセクションは、上端が画面の上端に来た位置から始める。本文がページ先頭から始まるときはスクロール位置 0
        // （「上端が画面中央」は 0 より手前になる）。前に表紙（index.html の .ptm-cover）があるときは、表紙を通り過ぎた位置。
        // どちらでも、その位置での本文カードの配置は同じなので、場面1は同じ進み方で始まる。
        start: i === 0 ? 'top top' : 'top center',
        // 最後の場面は、場面の下端が画面の下端に来るまで。文書の最大のスクロール位置（'max'）にすると、
        // 場面のあとに続く「データと方法」の節の長さぶんだけ最後の場面の進捗の範囲が伸び、カメラが止まる区間が短くなる。
        end: i === last ? 'bottom bottom' : 'bottom center',
        onUpdate: () => recompute(),
      }),
    );
  });
  ready = true;

  function stateFromProgresses(progressOf: (i: number) => number): StoryState {
    // 進捗が 0 より大きい最後のセクションが現在の段階。
    let stage = 0;
    for (let i = triggers.length - 1; i >= 0; i--) {
      if (progressOf(i) > 0) {
        stage = i;
        break;
      }
    }
    const progress = progressOf(stage);
    return { stage, progress, position: stage + progress };
  }

  const compute = (): StoryState => stateFromProgresses((i) => triggers[i]?.progress ?? 0);

  /** 現在のスクロール位置を、いま記録している start/end（計算し直す前のレイアウト）で状態に直す。 */
  function stateAtScroll(y: number): StoryState {
    return stateFromProgresses((i) => {
      const t = triggers[i];
      if (!t) return 0;
      const span = t.end - t.start;
      return span > 0 ? clamp01((y - t.start) / span) : y >= t.end ? 1 : 0;
    });
  }

  function scrollYFor(stage: number, progress: number): number {
    const t = triggers[Math.min(Math.max(stage, 0), last)];
    if (!t) return 0;
    return t.start + (t.end - t.start) * clamp01(progress);
  }

  function computeHolds(): void {
    const half = window.innerHeight / 2;
    holds = sections.map((section, i) => {
      const t = triggers[i];
      if (!t) return 0;
      const span = t.end - t.start;
      if (span <= 0) return 0;
      // 既定: カードの下端が画面中央に来るスクロール位置。
      const y = options.holdScrollY
        ? options.holdScrollY(section, i)
        : cardOf(section).getBoundingClientRect().bottom + window.scrollY - half;
      return Math.min(clamp01((y - t.start) / span), maxHold);
    });
  }

  function notifyStage(index: number, progress: number): void {
    const stage = stages[index];
    stage?.onProgress?.(progress, { index, stage });
  }

  /** すべての段階へ、現在の状態に合う進捗を通知する。 */
  function notifyAll(): void {
    stages.forEach((_, i) => {
      notifyStage(i, i < state.stage ? 1 : i > state.stage ? 0 : state.progress);
    });
  }

  function emit(): void {
    for (const l of [...listeners]) l(state);
  }

  function recompute(): void {
    if (!ready || frozen || disposed) return;
    const next = compute();
    const prev = state;
    if (next.stage === prev.stage && next.progress === prev.progress) return;
    state = next;

    if (next.stage > prev.stage) {
      // 進んで離れた段階（飛び越えた段階を含む）へ 1 を渡して締める。
      for (let i = prev.stage; i < next.stage; i++) notifyStage(i, 1);
    } else if (next.stage < prev.stage) {
      for (let i = prev.stage; i > next.stage; i--) notifyStage(i, 0);
    }
    notifyStage(next.stage, next.progress);
    emit();
  }

  function freeze(at: StoryState): void {
    if (frozen) return;
    frozen = true;
    saved = at;
    savedScrollY = window.scrollY;
  }

  /** 計算し直しの後、記録しておいた位置へスクロールを戻す。 */
  function restore(): void {
    computeHolds();
    const target = saved;
    saved = null;
    frozen = false;
    if (target) {
      // 最初の段階が始まる前（表紙）は進捗では表せないので、元のスクロール位置を、最初の段階の始まりを超えない範囲で保つ。
      const beforeStart = target.stage === 0 && target.progress <= 0;
      const y = Math.round(beforeStart ? Math.min(savedScrollY, scrollYFor(0, 0)) : scrollYFor(target.stage, target.progress));
      if (Math.abs(window.scrollY - y) >= 1) {
        window.scrollTo({ top: y, left: 0, behavior: 'instant' });
        ScrollTrigger.update();
      }
    }
    recompute();
    // 同じ位置に戻せても、レイアウトが変わったことをリスナー（カメラの止まる区間など）へ知らせる。
    emit();
  }

  const onRefreshInit = (): void => freeze(stateAtScroll(window.scrollY));
  const onRefresh = (): void => restore();
  ScrollTrigger.addEventListener('refreshInit', onRefreshInit);
  ScrollTrigger.addEventListener('refresh', onRefresh);

  // リサイズでは、ScrollTrigger が計算し直す前に（スクロールアンカーなどでスクロール位置が動く前に）読んでいた位置を記録する。
  let lastWidth = window.innerWidth;
  let lastHeight = window.innerHeight;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const isTouch = (): boolean =>
    typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
  const onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const minor = w === lastWidth && Math.abs(h - lastHeight) < lastHeight * MINOR_HEIGHT_CHANGE && isTouch();
    if (minor) return; // アドレスバーの出入り。ScrollTrigger も計算し直さない。
    lastWidth = w;
    lastHeight = h;
    freeze(state);
    // ScrollTrigger の自動の計算し直しは、スクロール中だと止まるまで待つ。待たずに確実に計算し直す。
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!disposed) ScrollTrigger.refresh();
    }, 150);
  };
  window.addEventListener('resize', onResize);

  // 初期状態を確定させ（リロード時にスクロール位置が復元されている場合を含む）、各段階へ通知する。
  state = compute();
  computeHolds();
  notifyAll();

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
      notifyAll();
    },
    getHolds: () => holds,
    scrollYFor,
    dispose() {
      disposed = true;
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      ScrollTrigger.removeEventListener('refreshInit', onRefreshInit);
      ScrollTrigger.removeEventListener('refresh', onRefresh);
      for (const t of triggers) t.kill();
      listeners.clear();
    },
  };
}
