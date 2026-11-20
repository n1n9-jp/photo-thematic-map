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

export type MarkerShape = 'column' | 'cone';

// ---------------------------------------------------------------------------
// 大きさ（拡大の倍率）
// ---------------------------------------------------------------------------

/** 柱: 高さ 1km あたりの台数。柱の高さ(m) = 台数 / COLUMN_BICYCLES_PER_KM × 1000。 */
export const COLUMN_BICYCLES_PER_KM = 100;
/** 柱の半径(m)。台数によらず一定（遠くからでも点として見えるように、高さに比べて太め）。 */
export const COLUMN_RADIUS_M = 110;

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
        if (x < margin || y < margin || x + w > viewport.width - margin || y + h > viewport.height - margin) continue;
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

export interface OverlayOptions {
  /** 凡例を出すか（既定 true）。 */
  legend?: boolean;
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
  private readonly material = new MeshLambertMaterial({ color: 0xffffff });
  private readonly geometries: Record<MarkerShape, BufferGeometry>;
  private readonly placements: Placement[];
  /** 台数の多い順の `sites` の添字。 */
  private readonly rank: number[];
  private readonly groundY: (lat: number, lon: number) => number;
  private shapeName: MarkerShape;
  private visibilityValue = 1;
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
    const color = new Color();
    sites.forEach((s, i) => {
      this.mesh.setColorAt(i, color.setHex(COLOR_STEPS[colorStepIndex(s.bicycles)]!.color));
    });
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

  /** ラベルを付ける駅の数を変える。 */
  setTopLabels(count: number): void {
    this.topLabelCount = Math.max(0, Math.floor(count));
    this.overlay?.invalidate();
  }

  /** 印の頂点（ラベルの位置）のワールド座標。`siteIndex` は `sites` の添字。 */
  anchor(siteIndex: number, target = new Vector3()): Vector3 {
    const p = this.placements[siteIndex]!;
    const { height } = markerSize(this.shapeName, this.sites[siteIndex]!.bicycles);
    return target.set(p.x, p.y + height, p.z);
  }

  /** 印の底（地表）のワールド座標。 */
  base(siteIndex: number, target = new Vector3()): Vector3 {
    const p = this.placements[siteIndex]!;
    return target.set(p.x, p.y, p.z);
  }

  /** ラベルと凡例を `container` に重ねる。`container` は position が static 以外にしておく。 */
  mountOverlay(container: HTMLElement, options: OverlayOptions = {}): void {
    this.overlay?.dispose();
    this.overlay = new Overlay(this, container, options.legend ?? true);
    this.overlay.setOpacity(this.visibilityValue);
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
    this.sites.forEach((s, i) => {
      const p = this.placements[i]!;
      const { height, radius } = markerSize(this.shapeName, s.bicycles);
      m.makeScale(radius, height, radius).setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// ラベル・凡例（DOM）
// ---------------------------------------------------------------------------

const STYLE_ID = 'station-markers-style';
const FONT = '"Hiragino Sans","Noto Sans JP","Yu Gothic","Meiryo","WenQuanYi Zen Hei",sans-serif';

const CSS = `
.sm-overlay{position:absolute;inset:0;overflow:hidden;pointer-events:none;font-family:${FONT};color:#fff}
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
`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const fmt = (n: number): string => n.toLocaleString('en-US');

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

/** 大きさの見本（台数に比例した相対的な大きさ）を描く SVG。 */
function sampleGlyphs(shape: MarkerShape): SVGSVGElement {
  const maxH = 46;
  const sizes = SAMPLE_COUNTS.map((n) => markerSize(shape, n));
  const scale = maxH / sizes[sizes.length - 1]!.height;
  const colW = 54;
  const width = colW * SAMPLE_COUNTS.length;
  const base = maxH + 2;
  const svg = svgEl('svg', { width, height: maxH + 17, viewBox: `0 0 ${width} ${maxH + 17}` });
  SAMPLE_COUNTS.forEach((n, i) => {
    const cx = colW * i + colW / 2;
    const color = `#${COLOR_STEPS[colorStepIndex(n)]!.color.toString(16).padStart(6, '0')}`;
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

class Overlay {
  private readonly root = document.createElement('div');
  private readonly lines: SVGSVGElement;
  private readonly labels = new Map<number, HTMLDivElement>();
  private readonly legend: HTMLDivElement | null;
  private readonly keyHost: HTMLDivElement | null = null;
  private readonly scaleText: HTMLDivElement | null = null;
  private lastKey = '';
  private readonly v = new Vector3();

  constructor(
    private readonly markers: StationMarkers,
    container: HTMLElement,
    withLegend: boolean,
  ) {
    ensureStyle();
    this.root.className = 'sm-overlay';
    this.lines = svgEl('svg', { class: 'sm-lines' });
    this.root.appendChild(this.lines);

    if (withLegend) {
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
        sw.style.background = `#${step.color.toString(16).padStart(6, '0')}`;
        li.append(sw, `${step.label}台`);
        steps.appendChild(li);
      }
      const total = document.createElement('div');
      total.className = 'sm-legend-total';
      let sum = 0;
      for (const s of markers.sites) sum += s.bicycles;
      total.textContent = `合計 ${fmt(sum)}台（${fmt(markers.sites.length)}か所）`;
      const note = document.createElement('div');
      note.className = 'sm-legend-note';
      note.textContent = '2025年10月、晴天の平日の午前11時頃に数えた台数';
      legend.append(title, key, steps, total, note);
      this.root.appendChild(legend);
      this.legend = legend;
      this.keyHost = key;
      this.scaleText = scale;
      key.append(sampleGlyphs(markers.shape), scale);
      scale.textContent = markerScaleText(markers.shape);
    } else {
      this.legend = null;
    }
    container.appendChild(this.root);
  }

  setShape(shape: MarkerShape): void {
    if (this.keyHost && this.scaleText) {
      this.keyHost.replaceChildren(sampleGlyphs(shape), this.scaleText);
      this.scaleText.textContent = markerScaleText(shape);
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

  update(camera: PerspectiveCamera, extraObstacles: readonly Rect[]): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width === 0 || height === 0) return;

    const rootBox = this.root.getBoundingClientRect();
    const obstacles: Rect[] = [...extraObstacles];
    if (this.legend) {
      const b = this.legend.getBoundingClientRect();
      obstacles.push({ x: b.left - rootBox.left, y: b.top - rootBox.top, w: b.width, h: b.height });
    }

    camera.updateMatrixWorld();
    const key = [
      width,
      height,
      camera.projectionMatrix.elements.join(','),
      camera.matrixWorld.elements.join(','),
      this.markers.shape,
      this.markers.labelLimit,
      obstacles.map((o) => `${o.x | 0},${o.y | 0},${o.w | 0},${o.h | 0}`).join(';'),
    ].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    // 画面内にある台数の多い駅から、ラベルを付ける駅を選ぶ
    const picks: Array<{ index: number; ax: number; ay: number }> = [];
    for (const index of this.markers.labelCandidates()) {
      if (picks.length >= this.markers.labelLimit) break;
      this.markers.anchor(index, this.v).project(camera);
      if (this.v.z < -1 || this.v.z > 1) continue;
      const ax = ((this.v.x + 1) / 2) * width;
      const ay = ((1 - this.v.y) / 2) * height;
      if (ax < 0 || ax > width || ay < 0 || ay > height) continue;
      picks.push({ index, ax, ay });
    }

    const requests: LabelRequest[] = picks.map(({ index, ax, ay }) => {
      const el = this.labelElement(index);
      el.style.display = 'block';
      return { id: String(index), ax, ay, w: el.offsetWidth, h: el.offsetHeight };
    });
    const placed = layoutLabels(requests, { width, height }, obstacles);
    const placedIds = new Set(placed.map((p) => p.id));
    for (const [index, el] of this.labels) {
      if (!placedIds.has(String(index))) el.style.display = 'none';
    }

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
      this.root.appendChild(el);
      this.labels.set(index, el);
    }
    return el;
  }
}
