/**
 * 駅ごとの放置自転車の台数を、立体の印（柱 / 山）で見せる。
 *
 * 東京全体を見渡す縮尺（高さ 25〜30km）では自転車1台は1ピクセルより小さいので、
 * 駅（`siteKey` ごとに合算した場所）ごとに、台数に応じた大きさの印を1回の描画呼び出し（InstancedMesh）で置く。
 *
 * - 柱（column）: 高さが台数に比例する細い円柱。
 * - 山（cone）: 体積が台数に比例する円錐。作品の後半で積む自転車の山と呼応する形。
 *
 * どちらも実物の大きさでは見えないため拡大して描く。拡大の倍率は形ごとに1つの定数
 * （`COLUMN_BICYCLES_PER_KM`、`CONE_BICYCLES_PER_KM3`）で決まり、凡例の文言（`markerScaleText`）にそのまま使う。
 * 印はワールド座標の実寸（1単位 = 1m）で置くので、凡例の「1km」は画面上でもそのまま 1km に見える。
 *
 * 色は台数の段階（`COLOR_STEPS`）で決める。少ない駅は淡い黄、多い駅は濃い赤。
 * 全体の表示は `setVisibility(0〜1)` で滑らかに切り替えられる（場面の切り替えのフェード用）。
 * 柱の伸び（`setGrowth(0〜1)`）と、色の切り替え（`setColorBlend(0〜1)`: 0 は台数の段階、1 は駐輪場の空きの有無）も
 * 外から動かせる（本編の場面3・4）。
 *
 * ラベルと凡例は DOM で重ねる（`mountOverlay`）。ラベルは台数の多い上位の駅に付け、
 * 画面上で重ならない位置を `layoutLabels` が決める（画面外の駅は数えず、画面内の上位から選ぶ）。
 */
import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import type { StationSite } from '../data/stations';
import { latLonToLocal } from '../geo/enu';
import { smoothstep } from '../story/cameraPath';

export type MarkerShape = 'column' | 'cone';

// ---------------------------------------------------------------------------
// 大きさ（拡大の倍率）
// ---------------------------------------------------------------------------

/** 柱: 高さ 1km あたりの台数。柱の高さ(m) = 台数 / COLUMN_BICYCLES_PER_KM × 1000。 */
export const COLUMN_BICYCLES_PER_KM = 50;
/** 柱の半径(m)。台数によらず一定（遠くからでも点として見えるように、高さに比べて太め）。 */
export const COLUMN_RADIUS_M = 140;

/** 山: 体積 1km³ あたりの台数。円錐の体積(m³) = 台数 / CONE_BICYCLES_PER_KM3 × 1e9。 */
export const CONE_BICYCLES_PER_KM3 = 500;
/** 山: 高さ ÷ 底の半径。 */
export const CONE_HEIGHT_PER_RADIUS = 2;

export interface MarkerSize {
  /** 高さ(m)。 */
  height: number;
  /** 底の半径(m)。 */
  radius: number;
}

/** 台数に対する印の実寸。 */
export function markerSize(shape: MarkerShape, bicycles: number): MarkerSize {
  if (shape === 'column') {
    return { height: (bicycles / COLUMN_BICYCLES_PER_KM) * 1000, radius: COLUMN_RADIUS_M };
  }
  const volume = (bicycles / CONE_BICYCLES_PER_KM3) * 1e9;
  // V = π r² h / 3, h = k r  →  r = ³√(3V / (π k))
  const radius = Math.cbrt((3 * volume) / (Math.PI * CONE_HEIGHT_PER_RADIUS));
  return { height: radius * CONE_HEIGHT_PER_RADIUS, radius };
}

/** 印の体積(m³)。 */
export function markerVolume(shape: MarkerShape, size: MarkerSize): number {
  const base = Math.PI * size.radius * size.radius * size.height;
  return shape === 'column' ? base : base / 3;
}

/** 凡例に書く、拡大の倍率の文言。 */
export function markerScaleText(shape: MarkerShape): string {
  return shape === 'column'
    ? `柱の高さ 1km ＝ ${COLUMN_BICYCLES_PER_KM}台`
    : `山の体積 1km³ ＝ ${CONE_BICYCLES_PER_KM3}台（高さ＝底の半径×${CONE_HEIGHT_PER_RADIUS}）`;
}

// ---------------------------------------------------------------------------
// 色の段階
// ---------------------------------------------------------------------------

export interface ColorStep {
  /** この段階の台数の下限（含む）。 */
  min: number;
  /** 上限（含む）。最後の段階は null。 */
  max: number | null;
  color: number;
  /** 凡例の表記。 */
  label: string;
}

/** 少ない駅は淡い黄、多い駅は濃い赤。灰色〜緑の地面・航空写真の上でも段階を見分けられる色。 */
export const COLOR_STEPS: readonly ColorStep[] = [
  { min: 1, max: 9, color: 0xffe35c, label: '1〜9' },
  { min: 10, max: 29, color: 0xffa726, label: '10〜29' },
  { min: 30, max: 99, color: 0xf4511e, label: '30〜99' },
  { min: 100, max: 199, color: 0xc2185b, label: '100〜199' },
  { min: 200, max: null, color: 0x6a1b9a, label: '200以上' },
];

/** 駐輪場の空きで色分けするときの色。空きが放置台数以上の駅は青、未満の駅は橙。 */
export const VACANCY_COLORS = { enough: 0x2f8cff, short: 0xff5a1f } as const;

/** 色分けの凡例（駐輪場の空き）。 */
export const VACANCY_LEGEND: readonly { color: number; label: string }[] = [
  { color: VACANCY_COLORS.enough, label: '駐輪場の空きが放置台数以上' },
  { color: VACANCY_COLORS.short, label: '駐輪場の空きが放置台数未満' },
];

/** 凡例の色の意味。count: 台数の段階、vacancy: 駐輪場の空きの有無。 */
export type ColorMode = 'count' | 'vacancy';

/** 台数が入る色の段階の番号。 */
export function colorStepIndex(bicycles: number): number {
  for (let i = COLOR_STEPS.length - 1; i >= 0; i--) {
    if (bicycles >= COLOR_STEPS[i]!.min) return i;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// ラベルの配置（純粋関数）
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelRequest {
  id: string;
  /** 印の位置（画面の px）。 */
  ax: number;
  ay: number;
  /** ラベルの大きさ（px）。 */
  w: number;
  h: number;
}

export interface PlacedLabel extends LabelRequest {
  /** ラベルの左上（px）。 */
  x: number;
  y: number;
  /** 印とラベルが離れていて、引き出し線が要るか。 */
  leader: boolean;
}

export interface LayoutOptions {
  /** 画面の端からの余白(px)。既定 4。 */
  margin?: number;
  /** ラベルどうし・障害物との最小の隙間(px)。既定 3。 */
  gap?: number;
  /** 印からラベルまでの距離の候補(px)。近い順。 */
  distances?: readonly number[];
  /** ラベルを置ける範囲。省略時は画面全体（`viewport`）。 */
  bounds?: Rect;
}

const DEFAULT_DISTANCES = [8, 26, 50, 78, 110, 150, 200];

const overlaps = (a: Rect, b: Rect, gap: number): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/**
 * ラベルを、画面上で重ならないように置く。`requests` の先頭ほど優先（近い位置に置く）。
 * 置けるところがなければ、そのラベルは出さない。他の印（`requests` の位置）と `obstacles` には重ねない。
 */
export function layoutLabels(
  requests: readonly LabelRequest[],
  viewport: { width: number; height: number },
  obstacles: readonly Rect[] = [],
  options: LayoutOptions = {},
): PlacedLabel[] {
  const margin = options.margin ?? 4;
  const gap = options.gap ?? 3;
  const distances = options.distances ?? DEFAULT_DISTANCES;
  const bounds: Rect = options.bounds ?? { x: 0, y: 0, w: viewport.width, h: viewport.height };
  const keepOut: Rect[] = [
    ...obstacles,
    ...requests.map((r) => ({ x: r.ax - 3, y: r.ay - 3, w: 6, h: 6 })),
  ];
  const placed: PlacedLabel[] = [];

  for (const req of requests) {
    const { ax, ay, w, h } = req;
    // 右上・右・左上・左・右下・左下・上・下 の順に試す
    for (const d of distances) {
      const candidates: Array<[number, number]> = [
        [ax + d, ay - d - h],
        [ax + d, ay - h / 2],
        [ax - d - w, ay - d - h],
        [ax - d - w, ay - h / 2],
        [ax + d, ay + d],
        [ax - d - w, ay + d],
        [ax - w / 2, ay - d - h],
        [ax - w / 2, ay + d],
      ];
      let found: PlacedLabel | undefined;
      for (const [x, y] of candidates) {
        if (x < bounds.x + margin || y < bounds.y + margin || x + w > bounds.x + bounds.w - margin || y + h > bounds.y + bounds.h - margin) continue;
        const rect: Rect = { x, y, w, h };
        if (placed.some((p) => overlaps(rect, p, gap))) continue;
        if (keepOut.some((o) => overlaps(rect, o, gap))) continue;
        found = { ...req, x, y, leader: d > 8 };
        break;
      }
      if (found) {
        placed.push(found);
        break;
      }
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// 3D の印
// ---------------------------------------------------------------------------

export interface StationMarkersOptions {
  /** 印の形（既定 'column'）。 */
  shape?: MarkerShape;
  /**
   * 地表のワールド Y を返す関数。既定は高さ 0 として `latLonToLocal` で求めた Y
   * （接平面なので原点から離れるほど負になる）。PLATEAU など別の地表に載せるときに差し替える。
   */
  groundY?: (lat: number, lon: number) => number;
  /** ラベルを付ける駅の数（既定 10）。画面内の上位から選ぶ。 */
  topLabels?: number;
}

/** ラベルと凡例を置く範囲（`container` 左上が原点の px）。 */
export interface OverlayLayout {
  /** ラベルを置ける範囲。凡例もこの範囲の隅に置く。 */
  region: Rect;
  /** true なら凡例を小さくする（スマートフォン）。 */
  compact: boolean;
  /**
   * 凡例を置く隅。'top' なら範囲の左上、'bottom'（既定）なら範囲の左下。
   * 俯瞰では、柱が集まる範囲の外（地図の上側の余白）に置くために 'top' にする。範囲が十分に広ければ、凡例は横に長い形になる。
   */
  legendCorner?: 'top' | 'bottom';
  /** 範囲の中でラベルを重ねたくない矩形（出典表示など）。 */
  obstacles?: readonly Rect[];
}

export interface OverlayOptions {
  /** 凡例を出すか（既定 true）。 */
  legend?: boolean;
  /**
   * フレームごとに、ラベルと凡例の範囲を返す。省略時は container 全体（凡例は左下、スマートフォン幅では下端いっぱい）。
   * null を返したフレームは前回の配置のまま。
   */
  layout?: () => OverlayLayout | null;
}

interface Placement {
  x: number;
  y: number;
  z: number;
}

const DEFAULT_GROUND_Y = (lat: number, lon: number): number => latLonToLocal({ lat, lon, alt: 0 }).y;

function unitGeometry(shape: MarkerShape): BufferGeometry {
  // 底面を y=0 に、高さ・半径を 1 にそろえ、インスタンスの拡大で実寸にする
  const g = shape === 'column' ? new CylinderGeometry(1, 1, 1, 20) : new ConeGeometry(1, 1, 28);
  g.translate(0, 0.5, 0);
  return g;
}

export class StationMarkers {
  /** シーンに加えるオブジェクト。 */
  readonly object = new Group();
  readonly sites: readonly StationSite[];

  private readonly mesh: InstancedMesh;
  // 遠景の霧で色が褪せないよう、霧は受けない
  private readonly material = new MeshLambertMaterial({ color: 0xffffff, fog: false });
  private readonly geometries: Record<MarkerShape, BufferGeometry>;
  private readonly placements: Placement[];
  /** 台数の多い順の `sites` の添字。 */
  private readonly rank: number[];
  private readonly groundY: (lat: number, lon: number) => number;
  private shapeName: MarkerShape;
  private visibilityValue = 1;
  private growthValue = 1;
  private colorBlendValue = 0;
  private legendModeValue: ColorMode = 'count';
  private topLabelCount: number;
  private overlay: Overlay | null = null;

  constructor(sites: readonly StationSite[], options: StationMarkersOptions = {}) {
    this.sites = sites;
    this.shapeName = options.shape ?? 'column';
    this.groundY = options.groundY ?? DEFAULT_GROUND_Y;
    this.topLabelCount = options.topLabels ?? 10;
    this.geometries = { column: unitGeometry('column'), cone: unitGeometry('cone') };

    this.placements = sites.map((s) => {
      const p = latLonToLocal({ lat: s.lat, lon: s.lon, alt: 0 });
      return { x: p.x, y: this.groundY(s.lat, s.lon), z: p.z };
    });
    this.rank = sites.map((_, i) => i).sort((a, b) => sites[b]!.bicycles - sites[a]!.bicycles || a - b);

    this.mesh = new InstancedMesh(this.geometries[this.shapeName], this.material, Math.max(1, sites.length));
    this.mesh.count = sites.length;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'station-markers';
    this.applyColors();
    this.applyShape();
    this.object.add(this.mesh);
  }

  get shape(): MarkerShape {
    return this.shapeName;
  }

  /** 印の形を切り替える。 */
  setShape(shape: MarkerShape): void {
    if (shape === this.shapeName) return;
    this.shapeName = shape;
    this.mesh.geometry = this.geometries[shape];
    this.applyShape();
    this.overlay?.setShape(shape);
  }

  get visibility(): number {
    return this.visibilityValue;
  }

  /** 全体の表示の度合い（0 で非表示、1 で完全に表示）。印・ラベル・凡例をまとめて変える。 */
  setVisibility(value: number): void {
    const v = Math.min(1, Math.max(0, value));
    this.visibilityValue = v;
    this.material.transparent = v < 1;
    this.material.opacity = v;
    this.material.needsUpdate = true;
    this.mesh.visible = v > 0;
    this.overlay?.setOpacity(v);
  }

  get growth(): number {
    return this.growthValue;
  }

  /** 印の伸び（0 で高さ 0、1 で台数どおりの高さ）。ラベルは伸びきる手前から現れる。 */
  setGrowth(value: number): void {
    const g = Math.min(1, Math.max(0, value));
    if (g === this.growthValue) return;
    this.growthValue = g;
    this.applyShape();
    this.overlay?.invalidate();
  }

  get colorBlend(): number {
    return this.colorBlendValue;
  }

  /** 色の切り替え（0: 台数の段階、1: 駐輪場の空きが放置台数以上かどうか）。途中の値は2色の中間色。 */
  setColorBlend(value: number): void {
    const t = Math.min(1, Math.max(0, value));
    if (t === this.colorBlendValue) return;
    this.colorBlendValue = t;
    this.applyColors();
  }

  get legendMode(): ColorMode {
    return this.legendModeValue;
  }

  /** 凡例の色の意味を切り替える。 */
  setLegendMode(mode: ColorMode): void {
    if (mode === this.legendModeValue) return;
    this.legendModeValue = mode;
    this.overlay?.setLegendMode(mode);
  }

  /** ラベルを付ける駅の数を変える。 */
  setTopLabels(count: number): void {
    const n = Math.max(0, Math.floor(count));
    if (n === this.topLabelCount) return;
    this.topLabelCount = n;
    this.overlay?.invalidate();
  }

  /** いま画面に出ているラベルの数（確認用）。 */
  get visibleLabelCount(): number {
    return this.overlay?.visibleLabelCount ?? 0;
  }

  /** 印の頂点（ラベルの位置）のワールド座標。`siteIndex` は `sites` の添字。 */
  anchor(siteIndex: number, target = new Vector3()): Vector3 {
    const p = this.placements[siteIndex]!;
    const { height } = markerSize(this.shapeName, this.sites[siteIndex]!.bicycles);
    return target.set(p.x, p.y + height * this.growthValue, p.z);
  }

  /** 印の底（地表）のワールド座標。 */
  base(siteIndex: number, target = new Vector3()): Vector3 {
    const p = this.placements[siteIndex]!;
    return target.set(p.x, p.y, p.z);
  }

  /** ラベルと凡例を `container` に重ねる。`container` は position が static 以外にしておく。 */
  mountOverlay(container: HTMLElement, options: OverlayOptions = {}): void {
    this.overlay?.dispose();
    this.overlay = new Overlay(this, container, options);
    this.overlay.setOpacity(this.visibilityValue);
    this.overlay.setLegendMode(this.legendModeValue);
  }

  /**
   * フレームごとに呼ぶ。カメラ・画面の大きさ・形・障害物が変わったときだけラベルを置き直す。
   * `obstacles` は、ラベルを重ねたくない画面上の矩形（コンテナ左上が原点の px）。
   */
  update(camera: PerspectiveCamera, obstacles: readonly Rect[] = []): void {
    this.overlay?.update(camera, obstacles);
  }

  dispose(): void {
    this.overlay?.dispose();
    this.overlay = null;
    this.geometries.column.dispose();
    this.geometries.cone.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  /** @internal Overlay から使う。 */
  labelCandidates(): readonly number[] {
    return this.rank;
  }

  /** @internal */
  get labelLimit(): number {
    return this.topLabelCount;
  }

  private applyShape(): void {
    const m = new Matrix4();
    const g = Math.max(this.growthValue, 1e-4);
    this.sites.forEach((s, i) => {
      const p = this.placements[i]!;
      const { height, radius } = markerSize(this.shapeName, s.bicycles);
      m.makeScale(radius, height * g, radius).setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private applyColors(): void {
    const byCount = new Color();
    const byVacancy = new Color();
    this.sites.forEach((s, i) => {
      byCount.setHex(COLOR_STEPS[colorStepIndex(s.bicycles)]!.color);
      if (this.colorBlendValue > 0) {
        byVacancy.setHex(s.vacancyCoversParked ? VACANCY_COLORS.enough : VACANCY_COLORS.short);
        byCount.lerp(byVacancy, this.colorBlendValue);
      }
      this.mesh.setColorAt(i, byCount);
    });
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// ラベル・凡例（DOM）
// ---------------------------------------------------------------------------

const STYLE_ID = 'station-markers-style';
const FONT = '"Hiragino Sans","Noto Sans JP","Yu Gothic","Meiryo","WenQuanYi Zen Hei",sans-serif';

const CSS = `
.sm-overlay{position:absolute;inset:0;overflow:hidden;pointer-events:none;font-family:${FONT};color:#fff}
.sm-labels{position:absolute;inset:0}
.sm-lines{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.sm-lines line{stroke:rgba(255,255,255,.9);stroke-width:1}
.sm-lines circle{fill:#fff;stroke:rgba(0,0,0,.6);stroke-width:1}
.sm-label{position:absolute;left:0;top:0;padding:2px 6px 3px;border-radius:4px;white-space:nowrap;
  background:rgba(12,16,22,.86);border:1px solid rgba(255,255,255,.5);line-height:1.25;text-align:left}
.sm-label-name{display:block;font-size:12px;font-weight:700}
.sm-label-count{display:block;font-size:12px;font-variant-numeric:tabular-nums;color:#ffd75e}
.sm-legend{position:absolute;left:10px;bottom:10px;width:292px;box-sizing:border-box;padding:9px 11px 8px;border-radius:6px;
  background:rgba(12,16,22,.86);border:1px solid rgba(255,255,255,.3);font-size:12px;line-height:1.45}
.sm-legend-title{font-size:13px;font-weight:700;margin-bottom:5px}
.sm-legend-key{display:flex;flex-direction:column;align-items:flex-start;gap:3px}
.sm-legend-key svg{flex:none;display:block}
.sm-legend-scale{font-size:12px;font-weight:700;color:#ffd75e}
.sm-legend-steps{display:flex;flex-wrap:wrap;gap:3px 9px;margin:7px 0 0;padding:0;list-style:none;font-size:11px}
.sm-legend-steps li{display:flex;align-items:center;gap:4px;white-space:nowrap}
.sm-legend-steps i{display:inline-block;width:11px;height:11px;border-radius:2px;border:1px solid rgba(255,255,255,.55)}
.sm-legend-steps[hidden]{display:none}
.sm-legend-vacancy{flex-direction:column;gap:3px;font-size:12px}
.sm-legend-vacancy[hidden]{display:none}
.sm-legend-total{margin-top:7px;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.sm-legend-note{margin-top:2px;font-size:10.5px;color:#d6dbe2}
@media (max-width:480px){
  .sm-label{padding:1px 4px 2px}
  .sm-label-name,.sm-label-count{font-size:11px}
  .sm-legend{left:6px;right:6px;bottom:6px;width:auto;padding:7px 9px 6px;font-size:11px}
  .sm-legend-title{font-size:12px;margin-bottom:3px}
  .sm-legend-scale{font-size:11px}
  .sm-legend-steps{margin-top:5px;font-size:10.5px;gap:2px 7px}
  .sm-legend-total{margin-top:5px;font-size:12px}
  .sm-legend-note{font-size:10px}
}
.sm-legend.sm-legend--wide{display:grid;grid-template-columns:auto 1fr;column-gap:16px;row-gap:3px;align-items:center;padding:8px 12px 7px}
.sm-legend--wide .sm-legend-title{grid-column:1/-1;margin-bottom:0}
.sm-legend--wide .sm-legend-key{grid-column:1;grid-row:2/4}
.sm-legend--wide .sm-legend-steps{grid-column:2;grid-row:2;margin:0}
.sm-legend--wide .sm-legend-total{grid-column:2;grid-row:3;margin:0}
.sm-legend--wide .sm-legend-note{grid-column:1/-1;margin-top:1px}
.sm-legend.sm-legend--compact{width:218px;padding:6px 8px 5px;font-size:10.5px;line-height:1.35}
.sm-legend--compact .sm-legend-title{font-size:11.5px;margin-bottom:2px}
.sm-legend--compact .sm-legend-key svg{display:none}
.sm-legend--compact .sm-legend-scale{font-size:10.5px}
.sm-legend--compact .sm-legend-steps{margin-top:3px;font-size:10px;gap:1px 6px}
.sm-legend--compact .sm-legend-steps i{width:9px;height:9px}
.sm-legend--compact .sm-legend-vacancy{font-size:10px;gap:2px}
.sm-legend--compact .sm-legend-total{margin-top:3px;font-size:11px}
.sm-legend--compact .sm-legend-note{font-size:9px}
`;

/** 凡例を横に長い形にする、範囲の幅(px)の下限と、そのときの凡例の幅。 */
const WIDE_LEGEND_MIN_REGION_W = 480;
const WIDE_LEGEND_WIDTH = 430;

const SVG_NS = 'http://www.w3.org/2000/svg';
const fmt = (n: number): string => n.toLocaleString('en-US');
const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const svgEl = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** 凡例に描く、大きさの見本の台数。 */
const SAMPLE_COUNTS = [20, 100, 400] as const;

/** 大きさの見本（台数に比例した相対的な大きさ）を描く SVG。色の意味が台数でないときは、見本は白。 */
function sampleGlyphs(shape: MarkerShape, mode: ColorMode): SVGSVGElement {
  const maxH = 46;
  const sizes = SAMPLE_COUNTS.map((n) => markerSize(shape, n));
  const scale = maxH / sizes[sizes.length - 1]!.height;
  const colW = 54;
  const width = colW * SAMPLE_COUNTS.length;
  const base = maxH + 2;
  const svg = svgEl('svg', { width, height: maxH + 17, viewBox: `0 0 ${width} ${maxH + 17}` });
  SAMPLE_COUNTS.forEach((n, i) => {
    const cx = colW * i + colW / 2;
    const color = mode === 'count' ? hex(COLOR_STEPS[colorStepIndex(n)]!.color) : '#cfd6de';
    const s = sizes[i]!;
    const h = Math.max(1, s.height * scale);
    const attrs = { fill: color, stroke: 'rgba(255,255,255,.7)', 'stroke-width': 0.8 };
    if (shape === 'column') {
      const w = 11;
      svg.appendChild(svgEl('rect', { x: cx - w / 2, y: base - h, width: w, height: h, ...attrs }));
    } else {
      const hw = s.radius * scale;
      svg.appendChild(svgEl('polygon', { points: `${cx - hw},${base} ${cx + hw},${base} ${cx},${base - h}`, ...attrs }));
    }
    const text = svgEl('text', { x: cx, y: base + 12, 'text-anchor': 'middle', 'font-size': 11, fill: '#fff' });
    text.textContent = `${n}台`;
    svg.appendChild(text);
  });
  svg.appendChild(svgEl('line', { x1: 2, y1: base, x2: width - 2, y2: base, stroke: 'rgba(255,255,255,.5)', 'stroke-width': 1 }));
  return svg;
}

const rectKey = (r: Rect): string => `${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0}`;

class Overlay {
  private readonly root = document.createElement('div');
  private readonly labelsHost = document.createElement('div');
  private readonly lines: SVGSVGElement;
  private readonly labels = new Map<number, HTMLDivElement>();
  private readonly legend: HTMLDivElement | null;
  private readonly keyHost: HTMLDivElement | null = null;
  private readonly scaleText: HTMLDivElement | null = null;
  private readonly steps: HTMLUListElement | null = null;
  private readonly vacancy: HTMLUListElement | null = null;
  private readonly layout: (() => OverlayLayout | null) | undefined;
  private lastLayout: OverlayLayout | null = null;
  private legendKey = '';
  private mode: ColorMode = 'count';
  private lastKey = '';
  private shownLabels = 0;
  private readonly v = new Vector3();

  constructor(
    private readonly markers: StationMarkers,
    container: HTMLElement,
    options: OverlayOptions,
  ) {
    ensureStyle();
    this.layout = options.layout;
    this.root.className = 'sm-overlay';
    this.labelsHost.className = 'sm-labels';
    this.lines = svgEl('svg', { class: 'sm-lines' });
    this.labelsHost.appendChild(this.lines);
    this.root.appendChild(this.labelsHost);

    if (options.legend ?? true) {
      const legend = document.createElement('div');
      legend.className = 'sm-legend';
      const title = document.createElement('div');
      title.className = 'sm-legend-title';
      title.textContent = '駅ごとの放置自転車（台数）';
      const key = document.createElement('div');
      key.className = 'sm-legend-key';
      const scale = document.createElement('div');
      scale.className = 'sm-legend-scale';
      const steps = document.createElement('ul');
      steps.className = 'sm-legend-steps';
      for (const step of COLOR_STEPS) {
        const li = document.createElement('li');
        const sw = document.createElement('i');
        sw.style.background = hex(step.color);
        li.append(sw, `${step.label}台`);
        steps.appendChild(li);
      }
      const vacancy = document.createElement('ul');
      vacancy.className = 'sm-legend-steps sm-legend-vacancy';
      vacancy.hidden = true;
      for (const item of VACANCY_LEGEND) {
        const li = document.createElement('li');
        const sw = document.createElement('i');
        sw.style.background = hex(item.color);
        li.append(sw, item.label);
        vacancy.appendChild(li);
      }
      const total = document.createElement('div');
      total.className = 'sm-legend-total';
      let sum = 0;
      for (const s of markers.sites) sum += s.bicycles;
      total.textContent = `合計 ${fmt(sum)}台（${fmt(markers.sites.length)}か所）`;
      const note = document.createElement('div');
      note.className = 'sm-legend-note';
      note.textContent = '2025年10月、晴天の平日の午前11時頃に数えた台数';
      legend.append(title, key, steps, vacancy, total, note);
      this.root.appendChild(legend);
      this.legend = legend;
      this.keyHost = key;
      this.scaleText = scale;
      this.steps = steps;
      this.vacancy = vacancy;
      key.append(sampleGlyphs(markers.shape, this.mode), scale);
      scale.textContent = markerScaleText(markers.shape);
    } else {
      this.legend = null;
    }
    container.appendChild(this.root);
  }

  get visibleLabelCount(): number {
    return this.shownLabels;
  }

  setShape(shape: MarkerShape): void {
    if (this.keyHost && this.scaleText) {
      this.keyHost.replaceChildren(sampleGlyphs(shape, this.mode), this.scaleText);
      this.scaleText.textContent = markerScaleText(shape);
    }
    this.invalidate();
  }

  setLegendMode(mode: ColorMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.keyHost && this.scaleText && this.steps && this.vacancy) {
      this.keyHost.replaceChildren(sampleGlyphs(this.markers.shape, mode), this.scaleText);
      this.steps.hidden = mode !== 'count';
      this.vacancy.hidden = mode !== 'vacancy';
    }
    this.invalidate();
  }

  setOpacity(v: number): void {
    this.root.style.opacity = String(v);
    this.root.style.visibility = v > 0 ? 'visible' : 'hidden';
  }

  invalidate(): void {
    this.lastKey = '';
  }

  /** 範囲に合わせて凡例を置く（`legendCorner` が 'top' なら範囲の左上、既定は左下。`compact` なら小さくする）。 */
  private placeLegend(layout: OverlayLayout, rootHeight: number): void {
    if (!this.legend) return;
    const { region, compact } = layout;
    const top = layout.legendCorner === 'top' || (layout.legendCorner === undefined && compact);
    // 上の隅に置くときは、範囲が広ければ横に長い形にして高さを抑える（地図の上側の余白に収め、柱を隠さない）
    const wide = top && !compact && region.w >= WIDE_LEGEND_MIN_REGION_W;
    const key = `${rectKey(region)}|${compact}|${top}|${wide}|${rootHeight}`;
    if (key === this.legendKey) return;
    this.legendKey = key;
    const s = this.legend.style;
    this.legend.classList.toggle('sm-legend--compact', compact);
    this.legend.classList.toggle('sm-legend--wide', wide);
    s.right = 'auto';
    s.left = `${Math.round(region.x + (compact ? 8 : 12))}px`;
    if (top) {
      s.top = `${Math.round(region.y + (compact ? 8 : 12))}px`;
      s.bottom = 'auto';
    } else {
      s.top = 'auto';
      s.bottom = `${Math.round(rootHeight - (region.y + region.h) + 12)}px`;
    }
    s.width = compact ? '' : wide ? `${Math.min(WIDE_LEGEND_WIDTH, region.w - 24)}px` : '292px';
  }

  update(camera: PerspectiveCamera, extraObstacles: readonly Rect[]): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width === 0 || height === 0) return;

    const layout = this.layout ? (this.layout() ?? this.lastLayout) : null;
    this.lastLayout = layout;
    if (layout) this.placeLegend(layout, height);

    const rootBox = this.root.getBoundingClientRect();
    const obstacles: Rect[] = [...extraObstacles, ...(layout?.obstacles ?? [])];
    if (this.legend) {
      const b = this.legend.getBoundingClientRect();
      obstacles.push({ x: b.left - rootBox.left, y: b.top - rootBox.top, w: b.width, h: b.height });
    }
    const bounds: Rect = layout?.region ?? { x: 0, y: 0, w: width, h: height };

    camera.updateMatrixWorld();
    const growth = this.markers.growth;
    // 柱が伸びきる手前から、ラベルが現れる
    this.labelsHost.style.opacity = String(smoothstep((growth - 0.55) / 0.45));
    const key = [
      width,
      height,
      camera.projectionMatrix.elements.join(','),
      camera.matrixWorld.elements.join(','),
      this.markers.shape,
      this.markers.labelLimit,
      growth,
      rectKey(bounds),
      obstacles.map(rectKey).join(';'),
    ].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    // 範囲の中にある台数の多い駅から、ラベルを付ける駅を選ぶ
    const picks: Array<{ index: number; ax: number; ay: number }> = [];
    for (const index of this.markers.labelCandidates()) {
      if (picks.length >= this.markers.labelLimit) break;
      this.markers.anchor(index, this.v).project(camera);
      if (this.v.z < -1 || this.v.z > 1) continue;
      const ax = ((this.v.x + 1) / 2) * width;
      const ay = ((1 - this.v.y) / 2) * height;
      if (ax < bounds.x || ax > bounds.x + bounds.w || ay < bounds.y || ay > bounds.y + bounds.h) continue;
      picks.push({ index, ax, ay });
    }

    const requests: LabelRequest[] = picks.map(({ index, ax, ay }) => {
      const el = this.labelElement(index);
      el.style.display = 'block';
      return { id: String(index), ax, ay, w: el.offsetWidth, h: el.offsetHeight };
    });
    const placed = layoutLabels(requests, { width, height }, obstacles, { bounds });
    const placedIds = new Set(placed.map((p) => p.id));
    for (const [index, el] of this.labels) {
      if (!placedIds.has(String(index))) el.style.display = 'none';
    }
    this.shownLabels = placed.length;

    this.lines.replaceChildren();
    for (const p of placed) {
      const el = this.labels.get(Number(p.id))!;
      el.style.transform = `translate(${p.x}px,${p.y}px)`;
      if (p.leader) {
        // 印から、ラベルの最も近い点へ線を引く
        const lx = Math.min(Math.max(p.ax, p.x), p.x + p.w);
        const ly = Math.min(Math.max(p.ay, p.y), p.y + p.h);
        this.lines.appendChild(svgEl('line', { x1: p.ax, y1: p.ay, x2: lx, y2: ly }));
      }
      this.lines.appendChild(svgEl('circle', { cx: p.ax, cy: p.ay, r: 2.5 }));
    }
  }

  dispose(): void {
    this.root.remove();
  }

  private labelElement(index: number): HTMLDivElement {
    let el = this.labels.get(index);
    if (!el) {
      const site = this.markers.sites[index]!;
      el = document.createElement('div');
      el.className = 'sm-label';
      el.dataset.site = site.name;
      const name = document.createElement('span');
      name.className = 'sm-label-name';
      name.textContent = site.shortName;
      const count = document.createElement('span');
      count.className = 'sm-label-count';
      count.textContent = `${fmt(site.bicycles)}台`;
      el.append(name, count);
      this.labelsHost.appendChild(el);
      this.labels.set(index, el);
    }
    return el;
  }
}
