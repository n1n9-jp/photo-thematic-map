/**
 * 街の上の地名（案内の文字）。駅のラベル（台数を示す墨の札）と見分けられるよう、札を付けず、墨の文字に紙の色の縁取りを付ける。
 * 縁取りがあるので、明るい地面・暗い地面・白い建物のどの上でも読める。
 *
 * - 出す地名は、呼び出し側が場面ごとに渡す（`setPlaces`）。そのうち、カメラの高さに合う段階（`PLACE_TIER_HEIGHTS`）で、
 *   注視点から近い（`SCOPE_PER_DISTANCE`）、画面の範囲（`bounds`）に入る地名だけを出す。
 * - 互いに、障害物（本文カード・凡例・駅のラベル・出典表示など、呼び出し側が渡す矩形）と、主役（`LabelKeepOut` を画面に
 *   投影した矩形）と重ならない位置を `layoutPlaceLabels` が決める。置けない地名は出さない。
 * - 出入りは不透明度の切り替え（CSS の transition）でなめらかにする。消える地名も、消えきるまで地点に付いて動く。
 * - スクリーンリーダーには読ませない（`aria-hidden`）。地名は本文（場面の見出しと本文）が言葉で伝えている場所の補助で、
 *   カメラが動くたびに出入りし並びも変わるので、読み上げると本文の流れを妨げる。
 */
import '../styles/tokens.css';
import { Vector3, type PerspectiveCamera } from 'three';
import { latLonToLocal, type Vec3 } from '../geo/enu';
import { PLACE_TIER_HEIGHTS, type PlaceKind, type PlaceName, type PlaceTier } from '../story/content/placeNames';
import type { Rect } from './stationMarkers';

export type { Rect } from './stationMarkers';

// ---------------------------------------------------------------------------
// 選び方（純粋関数）
// ---------------------------------------------------------------------------

/**
 * 地名を出す範囲: 注視点からの水平距離が、カメラの注視点までの距離のこの倍以内（`SCOPE_MIN_M` より狭くはしない）。
 * 寄ったときに遠くの地名を出さない。
 */
export const SCOPE_PER_DISTANCE = 4;
export const SCOPE_MIN_M = 150;

/** カメラの高さ(m、真下の地表から)で、その段階の地名を出すか。 */
export function tierVisibleAt(tier: PlaceTier, heightAboveGroundM: number): boolean {
  const r = PLACE_TIER_HEIGHTS[tier];
  return heightAboveGroundM >= r.min && heightAboveGroundM < r.max;
}

/** 地点（ローカル座標）が、注視点から見て出す範囲にあるか。 */
export function inScope(anchor: { x: number; z: number }, target: { x: number; z: number }, cameraDistanceM: number): boolean {
  return Math.hypot(anchor.x - target.x, anchor.z - target.z) <= Math.max(cameraDistanceM * SCOPE_PER_DISTANCE, SCOPE_MIN_M);
}

// ---------------------------------------------------------------------------
// 配置（純粋関数）
// ---------------------------------------------------------------------------

export interface PlaceLabelRequest {
  id: string;
  kind: PlaceKind;
  /** 地点の画面上の位置(px)。 */
  ax: number;
  ay: number;
  /** 文字の大きさ(px)。 */
  w: number;
  h: number;
  /** 地点のほかの候補（画面上の位置）。地点の周りが空いていないときに、順に試す（川の名前を水面の別の点に置く）。 */
  alternatives?: readonly { ax: number; ay: number }[];
  /** 前回置いた候補の番号（あれば先に試し、カメラが少し動いたくらいでは位置を変えない）。 */
  previous?: number;
}

export interface PlacedPlaceLabel extends PlaceLabelRequest {
  /** 文字の左上(px)。 */
  x: number;
  y: number;
  /** 置いた候補の番号（`CANDIDATES_PER_ANCHOR` × 地点の番号 + 地点の中の候補の番号）。 */
  candidate: number;
  /** 置いた地点の番号（0 が `ax, ay`、1 以降が `alternatives`）。`ax, ay` は置いた地点の位置になる。 */
  anchor: number;
  /** 地点の印から文字まで、引き出し線を引くか（駅・建物の名前を地点の真上へ離して置いたとき）。 */
  leader: boolean;
}

/** 1つの地点あたりの候補の数の上限（候補の番号の付け方）。 */
export const CANDIDATES_PER_ANCHOR = 16;

export interface PlaceLayoutOptions {
  /** 範囲の端からの余白(px)。既定 4。 */
  margin?: number;
  /** 障害物との最小の隙間(px)。既定 4。 */
  gap?: number;
  /** 地名どうしの最小の隙間(px)。既定 12（隣り合う2つの地名が、ひと続きの名前に読めないように）。 */
  labelGap?: number;
}

/** 'point' の地名の、地点の印の半径(px)と、印から文字までの距離(px)。 */
export const POINT_MARK_RADIUS = 3;
const POINT_OFFSET = 6;
/** 'point' の地名を、地点の真上へ引き出し線で離して置くときの、印から文字の下端までの距離(px)。 */
export const LEADER_LENGTHS = [24, 44] as const;
/** 'point' の候補のうち、引き出し線で離して置く候補の始まりの番号（`placeCandidates` の並び）。 */
const POINT_LEADER_FROM = 6;

const overlaps = (a: Rect, b: Rect, gap: number): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/**
 * 地名の文字を置く位置の候補（左上）。広がりの名前（area・water・road）は地点を中心に置き、重なるときは少しずつずらす
 * （ずらすのは文字の高さの 1.6 倍まで。それより離すと、どこの名前か分からなくなる）。
 * 駅・建物（point）は地点に印を付け、文字を印の右・左・上・下に置く。そこが埋まっていれば、地点の真上へ離して置き、
 * 印から引き出し線を引く（山の後ろの駅舎の屋根など。`isLeaderCandidate`）。
 */
export function placeCandidates(r: Pick<PlaceLabelRequest, 'kind' | 'ax' | 'ay' | 'w' | 'h'>): Array<[number, number]> {
  const { ax, ay, w, h } = r;
  if (r.kind === 'point') {
    const near: Array<[number, number]> = [
      [ax + POINT_OFFSET, ay - h / 2],
      [ax - POINT_OFFSET - w, ay - h / 2],
      [ax - w / 2, ay - POINT_OFFSET - h],
      [ax - w / 2, ay + POINT_OFFSET],
      [ax + POINT_OFFSET - 2, ay - POINT_OFFSET - h + 2],
      [ax - POINT_OFFSET - w + 2, ay - POINT_OFFSET - h + 2],
    ];
    // 真上へ離す: 文字の中央・左寄り・右寄りが線の上に来る
    const lifted = LEADER_LENGTHS.flatMap((d): Array<[number, number]> => [
      [ax - w / 2, ay - d - h],
      [ax - 8, ay - d - h],
      [ax - w + 8, ay - d - h],
    ]);
    return [...near, ...lifted];
  }
  const cx = ax - w / 2;
  const cy = ay - h / 2;
  return [
    [cx, cy],
    [cx, cy - h * 0.8],
    [cx, cy + h * 0.8],
    [cx - w * 0.3, cy],
    [cx + w * 0.3, cy],
    [cx, cy - h * 1.6],
    [cx, cy + h * 1.6],
  ];
}

/** 候補の番号（地点の中の番号）が、引き出し線で離して置く候補か。 */
export function isLeaderCandidate(kind: PlaceKind, index: number): boolean {
  return kind === 'point' && index >= POINT_LEADER_FROM;
}

/**
 * 地名を、範囲 `bounds` の中で、互いに・`obstacles` と重ならないように置く。`requests` の先頭ほど優先。
 * 'point' の地名の印も、ほかの地名が重ならない障害物にする。印そのものが障害物（主役・本文カード）に掛かる地点は使わない。
 * 引き出し線も、障害物とほかの地名に重ねない。置けない地名は返さない。
 */
export function layoutPlaceLabels(
  requests: readonly PlaceLabelRequest[],
  bounds: Rect,
  obstacles: readonly Rect[] = [],
  options: PlaceLayoutOptions = {},
): PlacedPlaceLabel[] {
  const margin = options.margin ?? 4;
  const gap = options.gap ?? 4;
  const labelGap = options.labelGap ?? 12;
  const marks: Rect[] = requests
    .filter((r) => r.kind === 'point')
    .map((r) => ({ x: r.ax - POINT_MARK_RADIUS, y: r.ay - POINT_MARK_RADIUS, w: POINT_MARK_RADIUS * 2, h: POINT_MARK_RADIUS * 2 }));
  const placed: PlacedPlaceLabel[] = [];
  /** 置いた地名の引き出し線。 */
  const lines: Rect[] = [];
  for (const req of requests) {
    const anchors = [{ ax: req.ax, ay: req.ay }, ...(req.alternatives ?? [])];
    const order: number[] = [];
    anchors.forEach((a, k) => placeCandidates({ ...req, ...a }).forEach((_, i) => order.push(k * CANDIDATES_PER_ANCHOR + i)));
    if (req.previous !== undefined && order.includes(req.previous)) {
      order.splice(order.indexOf(req.previous), 1);
      order.unshift(req.previous);
    }
    for (const c of order) {
      const k = Math.floor(c / CANDIDATES_PER_ANCHOR);
      const a = anchors[k]!;
      if (req.kind === 'point') {
        const mark: Rect = { x: a.ax - POINT_MARK_RADIUS, y: a.ay - POINT_MARK_RADIUS, w: POINT_MARK_RADIUS * 2, h: POINT_MARK_RADIUS * 2 };
        if (obstacles.some((o) => overlaps(mark, o, 0))) continue;
      }
      const inner = c % CANDIDATES_PER_ANCHOR;
      const [x, y] = placeCandidates({ ...req, ...a })[inner]!;
      if (x < bounds.x + margin || y < bounds.y + margin || x + req.w > bounds.x + bounds.w - margin || y + req.h > bounds.y + bounds.h - margin) {
        continue;
      }
      const rect: Rect = { x, y, w: req.w, h: req.h };
      if (placed.some((p) => overlaps(rect, p, labelGap))) continue;
      if (obstacles.some((o) => overlaps(rect, o, gap))) continue;
      if (marks.some((m) => overlaps(rect, m, 1))) continue;
      if (lines.some((l) => overlaps(rect, l, 1))) continue;
      const leader = isLeaderCandidate(req.kind, inner);
      if (leader) {
        // 引き出し線（印の上端から文字の下端まで）
        const line: Rect = { x: a.ax - 1, y: y + req.h, w: 2, h: a.ay - POINT_MARK_RADIUS - (y + req.h) };
        if (obstacles.some((o) => overlaps(line, o, 1)) || placed.some((p) => overlaps(line, p, 1))) continue;
        lines.push(line);
      }
      placed.push({ ...req, ax: a.ax, ay: a.ay, x, y, candidate: c, anchor: k, leader });
      break;
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// 主役を画面に投影した矩形
// ---------------------------------------------------------------------------

/** 地名を重ねない主役の形（ワールド座標）。場面のモジュールが返す（`SceneModule.labelKeepOut`）。 */
export interface LabelKeepOut {
  /** 点（x, y, z を並べた配列）と、その周りの半径(m)。画面上の半径は minPx を下回らない。自転車の群れ。 */
  points?: { positions: ArrayLike<number>; radiusM: number; minPx?: number };
  /** 線分（始点 x, y, z・終点 x, y, z を並べた配列）と、その周りの幅(px)。駅の柱。 */
  segments?: { positions: ArrayLike<number>; padPx: number };
  /** 箱（最小と最大の角）。 */
  boxes?: readonly { min: Vec3; max: Vec3 }[];
  /**
   * 円錐（底の中心・底の半径・高さ）。自転車の山。高さ方向に `CONE_STEPS` 段に分け、段ごとに上下の円を画面に投影して囲む
   * （頂上の横は空く。箱で囲むより、斜めから見たときに広がらない）。
   */
  cones?: readonly { base: Vec3; radiusM: number; heightM: number }[];
}

/** 円錐を囲む段の数と、円を投影するときの点の数。 */
export const CONE_STEPS = 5;
const CIRCLE_POINTS = 16;

/** 主役の形を、画面（左上が原点の px）の矩形にする。カメラの後ろにある部分は数えない。 */
export function keepOutRects(keepOut: LabelKeepOut, camera: PerspectiveCamera, width: number, height: number): Rect[] {
  const out: Rect[] = [];
  const v = new Vector3();
  const view = new Vector3();
  const focal = height / 2 / Math.tan(((camera.fov / camera.zoom) * Math.PI) / 360);
  /** ワールド座標を画面へ。カメラの後ろなら null。depth は視線方向の距離(m)。 */
  const project = (x: number, y: number, z: number): { x: number; y: number; depth: number } | null => {
    view.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    if (view.z > -camera.near) return null;
    v.set(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height, depth: -view.z };
  };
  const onScreen = (r: Rect): boolean => r.x + r.w > 0 && r.y + r.h > 0 && r.x < width && r.y < height;

  if (keepOut.points) {
    const { positions, radiusM, minPx = 3 } = keepOut.points;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const p = project(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      if (!p) continue;
      const r = Math.max(minPx, (radiusM * focal) / p.depth);
      const rect = { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 };
      if (onScreen(rect)) out.push(rect);
    }
  }
  if (keepOut.segments) {
    const { positions, padPx } = keepOut.segments;
    for (let i = 0; i + 5 < positions.length; i += 6) {
      const a = project(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      const b = project(positions[i + 3]!, positions[i + 4]!, positions[i + 5]!);
      if (!a || !b) continue;
      const x0 = Math.min(a.x, b.x) - padPx;
      const y0 = Math.min(a.y, b.y) - padPx;
      const rect = { x: x0, y: y0, w: Math.max(a.x, b.x) + padPx - x0, h: Math.max(a.y, b.y) + padPx - y0 };
      if (onScreen(rect)) out.push(rect);
    }
  }
  for (const cone of keepOut.cones ?? []) {
    const circle = (k: number): { x: number; y: number }[] | null => {
      const r = cone.radiusM * (1 - k / CONE_STEPS);
      const y = cone.base.y + (cone.heightM * k) / CONE_STEPS;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < (r > 0 ? CIRCLE_POINTS : 1); i++) {
        const a = (i / CIRCLE_POINTS) * Math.PI * 2;
        const p = project(cone.base.x + Math.cos(a) * r, y, cone.base.z + Math.sin(a) * r);
        if (!p) return null;
        pts.push(p);
      }
      return pts;
    };
    for (let k = 0; k < CONE_STEPS; k++) {
      const lower = circle(k);
      const upper = circle(k + 1);
      if (!lower || !upper) {
        out.push({ x: 0, y: 0, w: width, h: height });
        break;
      }
      const pts = [...lower, ...upper];
      const x0 = Math.min(...pts.map((p) => p.x));
      const y0 = Math.min(...pts.map((p) => p.y));
      const rect = { x: x0, y: y0, w: Math.max(...pts.map((p) => p.x)) - x0, h: Math.max(...pts.map((p) => p.y)) - y0 };
      if (onScreen(rect)) out.push(rect);
    }
  }
  for (const box of keepOut.boxes ?? []) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let behind = false;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = project(x, y, z);
          if (!p) {
            behind = true;
            continue;
          }
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
      }
    }
    // 箱の一部がカメラの後ろにあるときは、箱が画面を広く覆っているので、画面全体を障害物にする
    const rect = behind ? { x: 0, y: 0, w: width, h: height } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (onScreen(rect)) out.push(rect);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 表示（DOM）
// ---------------------------------------------------------------------------

/** 場面の地名（id 付き）。 */
export type PlaceEntry = PlaceName & { id: string };

export interface PlaceLabelsOptions {
  /** 地点の地表の標高(m)。既定 0。 */
  groundHeight?: (lat: number, lon: number) => number;
  /** 一度に出す地名の数の上限（既定 8）。 */
  maxLabels?: number;
}

/** フレームごとの入力。 */
export interface PlaceLabelsFrame {
  /** 地名を置ける範囲（container 左上が原点の px）。本文カードに覆われていない範囲。 */
  bounds: Rect;
  /** 重ねない矩形（本文カード・凡例・駅のラベル・出典表示など）。 */
  obstacles?: readonly Rect[];
  /** 重ねない主役の形。 */
  keepOut?: LabelKeepOut | null;
  /** カメラの高さ（真下の地表から, m）。 */
  heightAboveGround: number;
  /** 注視点（ローカル座標）。 */
  target: { x: number; y: number; z: number };
  /** 一度に出す地名の数の上限（省略時は options の値）。 */
  maxLabels?: number;
}

/** E2E・確認用: 出ている地名。 */
export interface ShownPlaceLabel {
  id: string;
  name: string;
  kind: PlaceKind;
  tier: PlaceTier;
  /** 文字の矩形（container 左上が原点の px）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 地点の画面上の位置。 */
  ax: number;
  ay: number;
}

const STYLE_ID = 'place-labels-style';
/*
 * 色・書体・文字サイズ・縁取りは src/styles/tokens.css（--ptm-place-*）。
 * 文字の大きさは段階で変える（俯瞰の目印 > 地区 > 近くの通り・駅）。川と湾は淡い墨で字間を広く。
 */
const CSS = `
.pl-overlay{position:absolute;inset:0;overflow:hidden;pointer-events:none;font-family:var(--ptm-font-sans);line-height:var(--ptm-leading-none)}
.pl-label{position:absolute;left:0;top:0;padding:2px 1px;white-space:nowrap;color:var(--ptm-place-ink);
  font-weight:var(--ptm-weight-medium);letter-spacing:var(--ptm-tracking-place);text-shadow:var(--ptm-place-halo-shadow);
  opacity:0;transition:opacity var(--ptm-place-fade) var(--ptm-ease);will-change:transform,opacity}
.pl-label.is-shown{opacity:1}
.pl-label--region{font-size:var(--ptm-text-md)}
.pl-label--district{font-size:var(--ptm-text-base)}
.pl-label--local{font-size:var(--ptm-text-sm)}
.pl-label--water{color:var(--ptm-place-ink-water);letter-spacing:var(--ptm-tracking-place-wide)}
.pl-label--road{color:var(--ptm-place-ink-water);font-weight:var(--ptm-weight-regular)}
.pl-label--point{font-weight:var(--ptm-weight-bold);letter-spacing:var(--ptm-tracking-body)}
.pl-mark{position:absolute;left:0;top:0;box-sizing:border-box;width:7px;height:7px;border-radius:var(--ptm-radius-pill);
  background:var(--ptm-place-ink);box-shadow:0 0 0 1.5px var(--ptm-place-halo);opacity:0;
  transition:opacity var(--ptm-place-fade) var(--ptm-ease)}
.pl-mark.is-shown{opacity:1}
.pl-leader{position:absolute;left:0;top:0;width:1px;background:var(--ptm-place-ink);box-shadow:0 0 0 1px var(--ptm-place-halo);
  opacity:0;transform-origin:0 0;transition:opacity var(--ptm-place-fade) var(--ptm-ease)}
.pl-leader.is-shown{opacity:1}
@media (max-width:480px){
  .pl-label--region{font-size:var(--ptm-text-base)}
  .pl-label--district{font-size:var(--ptm-text-sm)}
  .pl-label--local{font-size:var(--ptm-text-xs)}
}
@media (prefers-reduced-motion:reduce){.pl-label,.pl-mark,.pl-leader{transition-duration:1ms}}
/* 強制カラー: 縁取り（影）が消えるので、システムの背景色の面に載せる。 */
@media (forced-colors:active){
  .pl-label{background:Canvas;color:CanvasText;border-radius:var(--ptm-radius-sm)}
  .pl-mark,.pl-leader{background:CanvasText;forced-color-adjust:none}
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

interface LabelState {
  entry: PlaceEntry;
  el: HTMLSpanElement;
  mark: HTMLSpanElement | null;
  /** 引き出し線（'point' の地名だけ）。 */
  line: HTMLSpanElement | null;
  /** 引き出し線を引いているか。 */
  leader: boolean;
  /** 地点のワールド座標（先頭が地名の地点、続きが置き場所のほかの候補 `PlaceName.alternatives`）。 */
  anchors: Vector3[];
  /** 出ている（消えかけている）地名を置いた地点の番号。 */
  anchorIndex: number;
  shown: boolean;
  /** 文字の左上の、地点からのずれ(px)。消えるあいだも地点に付いて動かすのに使う。 */
  dx: number;
  dy: number;
  /** 前回置いた候補（地点の番号と、地点の中の候補の番号）。 */
  candidate: { anchor: number; inner: number } | undefined;
  w: number;
  h: number;
}

const rectKey = (r: Rect): string => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`;

export class PlaceLabels {
  private readonly root = document.createElement('div');
  private readonly states = new Map<string, LabelState>();
  private active = new Set<string>();
  private order: string[] = [];
  private readonly groundHeight: (lat: number, lon: number) => number;
  private readonly maxLabels: number;
  private lastKey = '';
  private readonly v = new Vector3();
  private shownList: ShownPlaceLabel[] = [];
  private measuredWidth = 0;

  constructor(container: HTMLElement, options: PlaceLabelsOptions = {}) {
    ensureStyle();
    this.groundHeight = options.groundHeight ?? (() => 0);
    this.maxLabels = options.maxLabels ?? 8;
    this.root.className = 'pl-overlay';
    this.root.setAttribute('aria-hidden', 'true');
    container.appendChild(this.root);
  }

  /** 出す地名の候補を替える（先頭ほど優先）。空なら、出ている地名をすべて消す。 */
  setPlaces(places: readonly PlaceEntry[]): void {
    const ids = places.map((p) => p.id);
    if (ids.join('|') === this.order.join('|')) return;
    this.order = ids;
    this.active = new Set(ids);
    for (const p of places) {
      const s = this.states.get(p.id);
      if (s) {
        // 標高タイルの読み込みで地表の高さが分かったときのために、地点を置き直す
        this.setAnchors(s.anchors, p);
      } else {
        this.states.set(p.id, this.createState(p));
      }
    }
    this.lastKey = '';
  }

  /** いま出ている地名（確認用）。 */
  shown(): readonly ShownPlaceLabel[] {
    return this.shownList;
  }

  /** 全体の不透明度（0〜1）。 */
  setOpacity(value: number): void {
    this.root.style.opacity = String(Math.min(1, Math.max(0, value)));
  }

  /** フレームごとに呼ぶ。カメラと入力が変わったときだけ置き直す。 */
  update(camera: PerspectiveCamera, frame: PlaceLabelsFrame): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width === 0 || height === 0) return;
    if (width !== this.measuredWidth) {
      // 文字の大きさは画面の幅で変わる（狭い画面は一段小さい）ので、測り直す
      this.measuredWidth = width;
      for (const s of this.states.values()) s.w = s.h = 0;
    }
    camera.updateMatrixWorld();
    const obstacles = [...(frame.obstacles ?? [])];
    const keepOut = frame.keepOut ? keepOutRects(frame.keepOut, camera, width, height) : [];
    // 主役の形は数百の矩形になるので、和で代表させる（柱が伸びる・山が現れるときに置き直す）
    let keepOutSum = 0;
    for (const r of keepOut) keepOutSum += r.x + 3 * r.y + 5 * r.w + 7 * r.h;
    const key = [
      width,
      height,
      camera.projectionMatrix.elements.join(','),
      camera.matrixWorld.elements.join(','),
      rectKey(frame.bounds),
      obstacles.map(rectKey).join(';'),
      this.order.join('|'),
      Math.round(frame.heightAboveGround),
      keepOut.length,
      Math.round(keepOutSum),
    ].join('#');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const distance = camera.position.distanceTo(this.v.set(frame.target.x, frame.target.y, frame.target.z));
    const project = (anchor: Vector3): { ax: number; ay: number } | null => {
      const view = this.v.copy(anchor).applyMatrix4(camera.matrixWorldInverse);
      if (view.z > -camera.near) return null;
      this.v.copy(anchor).project(camera);
      if (this.v.z > 1) return null;
      return { ax: ((this.v.x + 1) / 2) * width, ay: ((1 - this.v.y) / 2) * height };
    };

    // 候補: 段階・範囲・画面の範囲に合う地名。地点の候補のうち、範囲に入るものを順に試す
    const requests: PlaceLabelRequest[] = [];
    /** 依頼の地点の番号 → 地名の地点の番号。 */
    const anchorMap = new Map<string, number[]>();
    const b = frame.bounds;
    for (const id of this.order) {
      const s = this.states.get(id)!;
      if (!tierVisibleAt(s.entry.tier, frame.heightAboveGround)) continue;
      const usable: { index: number; ax: number; ay: number }[] = [];
      s.anchors.forEach((anchor, index) => {
        if (!inScope(anchor, frame.target, distance)) return;
        const p = project(anchor);
        if (!p || p.ax < b.x || p.ax > b.x + b.w || p.ay < b.y || p.ay > b.y + b.h) return;
        usable.push({ index, ...p });
      });
      if (usable.length === 0) continue;
      if (s.w === 0 || s.h === 0) {
        s.w = s.el.offsetWidth;
        s.h = s.el.offsetHeight;
      }
      const map = usable.map((u) => u.index);
      anchorMap.set(id, map);
      const prevLocal = s.shown && s.candidate ? map.indexOf(s.candidate.anchor) : -1;
      requests.push({
        id,
        kind: s.entry.kind,
        ax: usable[0]!.ax,
        ay: usable[0]!.ay,
        alternatives: usable.slice(1).map(({ ax, ay }) => ({ ax, ay })),
        w: s.w,
        h: s.h,
        previous: prevLocal >= 0 ? prevLocal * CANDIDATES_PER_ANCHOR + s.candidate!.inner : undefined,
      });
    }
    const limit = frame.maxLabels ?? this.maxLabels;
    const rank = new Map(this.order.map((id, i) => [id, i]));
    // 前回出していた地名を先に試し、出入りを減らす。出していた地名どうし・新しい地名どうしは、優先の順（台本の順）
    const ordered = [...requests].sort((a, c) => {
      const sa = this.states.get(a.id)!.shown ? 0 : 1;
      const sc = this.states.get(c.id)!.shown ? 0 : 1;
      return sa - sc || rank.get(a.id)! - rank.get(c.id)!;
    });
    const placed = layoutPlaceLabels(ordered, frame.bounds, [...obstacles, ...keepOut]).slice(0, limit);
    const placedById = new Map(placed.map((p) => [p.id, p]));

    this.shownList = [];
    for (const [id, s] of this.states) {
      const p = placedById.get(id);
      if (p && this.active.has(id)) {
        s.dx = p.x - p.ax;
        s.dy = p.y - p.ay;
        s.anchorIndex = anchorMap.get(id)![p.anchor]!;
        s.leader = p.leader;
        s.candidate = { anchor: s.anchorIndex, inner: p.candidate % CANDIDATES_PER_ANCHOR };
        this.setShown(s, true);
        this.position(s, p.ax, p.ay);
        this.shownList.push({ id, name: s.entry.name, kind: s.entry.kind, tier: s.entry.tier, x: p.x, y: p.y, w: p.w, h: p.h, ax: p.ax, ay: p.ay });
        continue;
      }
      this.setShown(s, false);
      s.candidate = undefined;
      // 消えるあいだも、置いていた地点に付いて動かす
      const q = project(s.anchors[s.anchorIndex] ?? s.anchors[0]!);
      if (q) this.position(s, q.ax, q.ay);
    }
  }

  dispose(): void {
    this.root.remove();
    this.states.clear();
  }

  private position(s: LabelState, ax: number, ay: number): void {
    s.el.style.transform = `translate(${(ax + s.dx).toFixed(1)}px,${(ay + s.dy).toFixed(1)}px)`;
    if (s.mark) s.mark.style.transform = `translate(${(ax - 3.5).toFixed(1)}px,${(ay - 3.5).toFixed(1)}px)`;
    if (s.line && s.leader) {
      // 文字の下端から印の上端まで（高さ 1px の要素を縦に伸ばす）
      const top = ay + s.dy + s.h;
      const length = Math.max(0, ay - POINT_MARK_RADIUS - top);
      s.line.style.transform = `translate(${(ax - 0.5).toFixed(1)}px,${top.toFixed(1)}px) scaleY(${length.toFixed(1)})`;
    }
  }

  private setShown(s: LabelState, shown: boolean): void {
    s.line?.classList.toggle('is-shown', shown && s.leader);
    if (s.shown === shown) return;
    s.shown = shown;
    s.el.classList.toggle('is-shown', shown);
    s.mark?.classList.toggle('is-shown', shown);
  }

  private setAnchors(target: Vector3[], p: PlaceEntry): void {
    const points = [{ lat: p.lat, lon: p.lon }, ...(p.alternatives ?? [])];
    target.length = points.length;
    points.forEach((q, i) => {
      const local = latLonToLocal({ lat: q.lat, lon: q.lon, alt: this.groundHeight(q.lat, q.lon) + (p.heightM ?? 0) });
      target[i] = new Vector3(local.x, local.y, local.z);
    });
  }

  private createState(p: PlaceEntry): LabelState {
    const el = document.createElement('span');
    el.className = `pl-label pl-label--${p.tier} pl-label--${p.kind}`;
    el.dataset.place = p.id;
    el.textContent = p.name;
    let mark: HTMLSpanElement | null = null;
    let line: HTMLSpanElement | null = null;
    if (p.kind === 'point') {
      mark = document.createElement('span');
      mark.className = 'pl-mark';
      line = document.createElement('span');
      line.className = 'pl-leader';
      line.style.height = '1px';
      this.root.append(line, mark);
    }
    this.root.appendChild(el);
    const anchors: Vector3[] = [];
    this.setAnchors(anchors, p);
    return { entry: p, el, mark, line, leader: false, anchors, anchorIndex: 0, shown: false, dx: 0, dy: 0, candidate: undefined, w: el.offsetWidth, h: el.offsetHeight };
  }
}
