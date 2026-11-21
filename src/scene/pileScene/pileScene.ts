/**
 * 山の場面: 実数ぶんの自転車が上空から降って積もり、山になる。
 *
 * - 計算（堆積・成長の段階・充填）は Web Worker（`computePileInWorker`）で行う。
 * - 自転車は `BicycleField` の1つのまとまりとして描く。
 *   - 'full'（全台を詰める）: 成長の順に並べ、`setProgress(t)` で進み具合 t までに覆われる台数を表示する。
 *     表示に加わる自転車は上空から降る（順位による落下）。現在の表面から深い自転車は描かない（pile.mode='bury'）。
 *   - 'surface'（表層だけ）: 最終の表面の表層だけを置き、成長の途中は表面に合わせて段を下げて置く。
 *     表面が上がるたびに上空から降り直す（pile.mode='lattice'）。
 * - 山の表面より少し内側に暗い面を置き、自転車の隙間から地面が透けないようにする。暗い面も進み具合に合わせて育つ。
 * - 自転車の明るさは、表面の向き（光に対する斜面の向き）と、現在の表面からの深さで変える。
 *
 * 座標はローカル座標（X=東, Y=上=標高, Z=南, 1単位=1m）。自転車の Y は高さ格子の標高そのもの。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataArrayTexture,
  DataUtils,
  Group,
  HalfFloatType,
  LinearFilter,
  Mesh,
  RedFormat,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import type { GridName } from '../../data/grids';
import { latLonToLocal } from '../../geo/enu';
import { BicycleField, type BicycleFieldOptions, type BicycleFieldStats, type BicycleTone } from '../bicycle/field';
import { HIDE_DEPTH, countAtMost, stageAt, type PileComputeParams, type PileComputeProgress, type PileComputeResult, type PileMode } from './compute';
import { computePileInWorker } from './computeInWorker';

export interface PileSceneOptions {
  /** 街の高さ格子の名前。 */
  grid: GridName;
  /** 山を積む地点（開けた地表に寄せる）。 */
  lat: number;
  lon: number;
  /** 山全体が表す台数。 */
  count: number;
  /** 'full' は全台を詰める、'surface' は表層だけを置く。 */
  mode: PileMode;
  /** 1台あたりのかさ体積(m³)。既定 0.35。 */
  unitVolume?: number;
  /** 乱数の種。既定 1。 */
  seed?: number;
  /** 'surface' の表層の深さ（法線方向, m）。既定 0.8。 */
  surfaceDepth?: number;
  /** 落下を始める高さ（最終の位置からの高さ, m）。既定 'full' 60、'surface' 70。 */
  dropHeight?: number;
  /** 'full' の落下にかける台数の幅。既定 表す台数の 1.2%。 */
  fallWindow?: number;
  /** 動きを減らす（落下を省く）。既定は `prefers-reduced-motion: reduce` に従う。 */
  reducedMotion?: boolean;
  /** 自転車の描画の設定（詳細度の切り替え・上限・点景）。端末に合わせて変える。 */
  field?: BicycleFieldOptions;
  /** 自転車の色の調子。既定 {@link PILE_TONE}。 */
  tone?: BicycleTone;
  /** 表面から深い自転車の明るさ（0〜1）。既定 {@link PILE_DEEP_SHADE}。 */
  deepShade?: number;
  /** 暗い面の色（sRGB 16進）。既定 {@link PILE_SHELL_COLOR}。 */
  shellColor?: number;
  /** 計算の進み具合。 */
  onProgress?: (p: PileComputeProgress) => void;
  /** 計算の差し替え（既定は Web Worker）。 */
  compute?: (grid: string, params: PileComputeParams, onProgress?: (p: PileComputeProgress) => void) => Promise<PileComputeResult>;
}

/** 場面の情報（本文の数値や視点の決定に使う）。 */
export interface PileSceneInfo {
  mode: PileMode;
  /** 山の地点（開けた地表に寄せた後）。 */
  site: { x: number; z: number; groundY: number; shiftedBy: number };
  apexY: number;
  apexHeight: number;
  volume: number;
  area: number;
  representedCount: number;
  placedCount: number;
  /** 堆積の外接矩形（ローカル座標）。 */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  timings: PileComputeResult['timings'];
  fillStats: PileComputeResult['fillStats'];
}

export interface PileSceneStats {
  /** 進み具合に応じた、山が表す台数。 */
  represented: number;
  /** 表示している台数（現れた自転車。落下中を含む）。 */
  shown: number;
  /** 落下中の台数の目安（'full' のみ）。 */
  falling: number;
  /** 自転車の描画の統計。 */
  field: BicycleFieldStats;
  /** 暗い面の三角形数。 */
  shellTriangles: number;
  /** 描く三角形の総数（自転車 + 暗い面）。 */
  triangles: number;
}

export interface PileScene {
  /** シーンに加えるルート（自転車と暗い面）。 */
  readonly object: Group;
  readonly field: BicycleField;
  readonly info: PileSceneInfo;
  /** 計算結果（配列を含む）。 */
  readonly result: PileComputeResult;
  /** 進み具合（0〜1）。 */
  readonly progress: number;
  /**
   * 進み具合を設定する。0 で 0 台、1 で全台。
   * midair=true は「スクロールし続けている途中」の状態にする（確認用。落下中の自転車が空中にいる）。
   */
  setProgress(t: number, options?: { midair?: boolean }): void;
  /** 進み具合 t（省略時は現在）に応じた、山が表す台数（本文の数え上げ用）。 */
  representedCount(t?: number): number;
  /** 時間による落下の進行を止める（確認用）。 */
  pauseFalls: boolean;
  /** 動きを減らす設定。 */
  reducedMotion: boolean;
  /** 落下・降り直しの途中か（毎フレームの描画が要るか）。直近の `update` の時点。 */
  readonly animating: boolean;
  readonly stats: PileSceneStats;
  /** 毎フレーム、描画の前に呼ぶ。 */
  update(camera: PerspectiveCamera, viewportHeightPx: number): void;
  dispose(): void;
}

/** 暗い面を表面から下げる量（m）。 */
const SHELL_OFFSET: Record<PileMode, number> = { full: 0.9, surface: 0.6 };
/**
 * 暗い面の色。自転車の隙間から見えるので、真っ黒にせず、遠くから見た自転車の平均に近い灰褐色にする。
 */
export const PILE_SHELL_COLOR = 0x5a5550;
/**
 * 山の自転車の色の調子。遠くから見ると、黒・紺のフレームと影が重なって暗い塊に見えるので、
 * 暗いフレーム色を持ち上げ、彩度を上げ、陰影の暗い側を浅くする。
 */
export const PILE_TONE: BicycleTone = { lift: 0.55, saturation: 1.35, shadeFloor: 0.3 };
/** 表面から深い自転車の明るさ（BicycleField の既定 0.45 より浅くする）。 */
export const PILE_DEEP_SHADE = 0.6;
/** 'surface' の遅れ（降り直しの着地の基準）の追いかけ。 */
const LAG_TAU = 0.45;
const LAG_MIN_RATE = 0.03;
/** midair の遅れ（進み具合）。 */
const MIDAIR_LAG = 0.012;

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 計算（Web Worker）から場面を作る。 */
export async function createPileScene(options: PileSceneOptions): Promise<PileScene> {
  const p = latLonToLocal({ lat: options.lat, lon: options.lon });
  const params: PileComputeParams = {
    x: p.x,
    z: p.z,
    count: options.count,
    mode: options.mode,
    unitVolume: options.unitVolume,
    seed: options.seed,
    surfaceDepth: options.surfaceDepth,
  };
  const compute = options.compute ?? computePileInWorker;
  const result = await compute(options.grid, params, options.onProgress);
  return createPileSceneFromResult(result, options);
}

/** 計算済みの結果から場面を作る。 */
export function createPileSceneFromResult(
  result: PileComputeResult,
  options: Pick<PileSceneOptions, 'dropHeight' | 'fallWindow' | 'reducedMotion' | 'field' | 'tone' | 'deepShade' | 'shellColor'> & { surfaceDepth?: number } = {},
): PileScene {
  const mode = result.mode;
  const n = result.placedCount;
  const N = result.representedCount;
  const object = new Group();
  object.name = 'PileScene';

  // 段階ごとの厚さのテクスチャ
  const { layerWidth: lw, layerHeight: lh, layerRect, fractions } = result;
  const K = fractions.length;
  const texture = new DataArrayTexture(result.layers, lw, lh, K);
  texture.format = RedFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const cs = layerRect.cellSize;
  const rect = { x0: layerRect.x0, z0: layerRect.z0, sizeX: lw * cs, sizeZ: lh * cs };

  // 自転車
  const field = new BicycleField(options.field);
  field.tone = options.tone ?? PILE_TONE;
  field.deepShade = options.deepShade ?? PILE_DEEP_SHADE;
  field.reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  field.setPileSurface({ texture, rect });
  const dropHeight = options.dropHeight ?? (mode === 'full' ? 60 : 70);
  const fallWindow = mode === 'full' ? Math.max(1, Math.round(options.fallWindow ?? N * 0.012)) : 0;
  const group = field.addGroup(
    {
      count: n,
      positions: result.positions,
      origin: result.origin,
      quaternions: result.quaternions,
      colors: result.colors,
      shades: result.shades,
      pile:
        mode === 'surface'
          ? { height: result.pileHeight, spacing: result.spacing, maxLevel: result.maxLevel }
          : { height: result.pileHeight, hideAfter: result.hideAfter },
    },
    {
      reveal: 0,
      fall: { height: dropHeight, window: fallWindow },
      pile: mode === 'surface' ? { mode: 'lattice', shadeDepth: (options.surfaceDepth ?? 0.8) * 1.3, latticeWindow: 1 } : { mode: 'bury', hideDepth: HIDE_DEPTH + 0.4, shadeDepth: 1.4 },
    },
  );
  object.add(field.object);

  // 暗い面
  const shell = createShellMesh(result, texture, SHELL_OFFSET[mode], options.shellColor ?? PILE_SHELL_COLOR);
  object.add(shell.mesh);

  // 外接矩形（厚さのある範囲）
  const last = result.layers.subarray((K - 1) * lw * lh);
  let bx0 = Infinity;
  let bz0 = Infinity;
  let bx1 = -Infinity;
  let bz1 = -Infinity;
  for (let r = 0; r < lh; r++) {
    for (let c = 0; c < lw; c++) {
      if (last[r * lw + c] === 0) continue;
      const x = rect.x0 + (c + 0.5) * cs;
      const z = rect.z0 + (r + 0.5) * cs;
      bx0 = Math.min(bx0, x);
      bx1 = Math.max(bx1, x);
      bz0 = Math.min(bz0, z);
      bz1 = Math.max(bz1, z);
    }
  }
  const info: PileSceneInfo = {
    mode,
    site: result.site,
    apexY: result.apexY,
    apexHeight: result.apexHeight,
    volume: result.volume,
    area: result.area,
    representedCount: N,
    placedCount: n,
    bounds: { x0: bx0, z0: bz0, x1: bx1, z1: bz1 },
    timings: result.timings,
    fillStats: result.fillStats,
  };

  let progress = 0;
  let lag = 0; // 'surface' の降り直しの着地の基準（進み具合）
  let lastMs = -1;
  let pause = false;
  let animating = false;
  const shownAt = (t: number): number => countAtMost(result.arrivals, t);
  const representedAt = (t: number): number => (mode === 'full' ? shownAt(t) : Math.round(Math.min(1, Math.max(0, t)) * N));

  const applyStages = (): void => {
    const head = stageAt(fractions, progress);
    const headStage = { k0: head.k, k1: Math.min(K - 1, head.k + 1), mix: head.a };
    let landedT: number;
    if (mode === 'surface') {
      landedT = field.reducedMotion ? progress : lag;
    } else {
      const landed = field.getLandedCount(group);
      landedT = landed <= 0 ? 0 : landed >= n ? 1 : (result.arrivals[Math.floor(landed) - 1] as number);
      landedT = Math.min(progress, landedT);
    }
    const lagS = stageAt(fractions, landedT);
    const lagStage = { k0: lagS.k, k1: Math.min(K - 1, lagS.k + 1), mix: lagS.a };
    field.setPileSurfaceStage(headStage, lagStage);
    shell.setStage(lagStage);
  };

  const stats: PileSceneStats = { represented: 0, shown: 0, falling: 0, field: field.stats, shellTriangles: 0, triangles: 0 };

  const scene: PileScene = {
    object,
    field,
    info,
    result,
    get progress() {
      return progress;
    },
    setProgress(tIn, opts = {}) {
      const t = Math.min(1, Math.max(0, Number.isFinite(tIn) ? tIn : 0));
      progress = t;
      const shown = shownAt(t);
      if (mode === 'surface') {
        if (opts.midair) lag = Math.max(0, t - MIDAIR_LAG);
        else if (lag > t) lag = t; // 戻すときは空中に残さない
      }
      field.setRevealCount(shown, group, opts.midair && mode === 'full' ? { lead: 0 } : {});
      applyStages();
    },
    representedCount(t) {
      return representedAt(t ?? progress);
    },
    get pauseFalls() {
      return pause;
    },
    set pauseFalls(v: boolean) {
      pause = v;
      field.pauseFalls = v;
    },
    get reducedMotion() {
      return field.reducedMotion;
    },
    get animating() {
      return animating;
    },
    set reducedMotion(v: boolean) {
      field.reducedMotion = v;
    },
    stats,
    update(camera, viewportHeightPx) {
      const now = performance.now();
      const dt = lastMs < 0 ? 0 : Math.min(0.1, Math.max(0, (now - lastMs) / 1000));
      lastMs = now;
      if (mode === 'surface') {
        if (field.reducedMotion) lag = progress;
        else if (!pause && lag < progress && dt > 0) {
          lag = Math.min(progress, lag + Math.max((progress - lag) * (1 - Math.exp(-dt / LAG_TAU)), LAG_MIN_RATE * dt));
        }
      }
      field.update(camera, viewportHeightPx);
      applyStages();
      stats.represented = representedAt(progress);
      stats.shown = field.getRevealCount(group);
      stats.falling = field.stats.falling;
      stats.field = field.stats;
      stats.shellTriangles = shell.mesh.visible ? shell.triangles : 0;
      stats.triangles = field.stats.triangles + stats.shellTriangles;
      animating = !pause && (field.stats.falling > 0 || (mode === 'surface' && !field.reducedMotion && lag < progress));
    },
    dispose() {
      field.dispose();
      shell.dispose();
      texture.dispose();
      object.removeFromParent();
    },
  };
  scene.setProgress(0);
  return scene;
}

interface ShellMesh {
  mesh: Mesh;
  triangles: number;
  setStage(stage: { k0: number; k1: number; mix: number }): void;
  dispose(): void;
}

const SHELL_VERTEX = /* glsl */ `
precision highp sampler2DArray;
uniform highp sampler2DArray uSurf;
uniform vec3 uStage;
uniform float uOffset;
uniform vec2 uTexel;
uniform float uCell;
attribute vec4 aNb;
attribute float aSink;
varying float vT;
varying vec3 vN;
float shellThick(vec2 p) {
  float a = texture(uSurf, vec3(p, uStage.x)).r;
  float b = texture(uSurf, vec3(p, uStage.y)).r;
  return max(0.0, mix(a, b, uStage.z));
}
void main() {
  float t = shellThick(uv);
  vT = t - uOffset;
  float hx1 = aNb.x + shellThick(uv + vec2(uTexel.x, 0.0));
  float hx0 = aNb.y + shellThick(uv - vec2(uTexel.x, 0.0));
  float hz1 = aNb.z + shellThick(uv + vec2(0.0, uTexel.y));
  float hz0 = aNb.w + shellThick(uv - vec2(0.0, uTexel.y));
  vN = normalize(vec3(-(hx1 - hx0) / (2.0 * uCell), 1.0, -(hz1 - hz0) / (2.0 * uCell)));
  vec3 p = position;
  // 積もっていない頂点は周囲の最も低い地表より下へ沈める（建物の屋上へ向かって面が立ち上がらないように）
  p.y = vT > 0.0 ? p.y + vT : aSink - 0.3;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uLight;
varying float vT;
varying vec3 vN;
void main() {
  if (vT < 0.02) discard;
  float l = 0.55 + 0.45 * max(dot(normalize(vN), uLight), 0.0);
  gl_FragColor = vec4(uColor * l, 1.0);
  #include <colorspace_fragment>
}`;

/** 山の表面より offset だけ内側の暗い面（格子のセルの中心を頂点にする）。 */
function createShellMesh(result: PileComputeResult, texture: DataArrayTexture, offset: number, color: number): ShellMesh {
  const { layerWidth: lw, layerHeight: lh, layerRect, layerGround, fractions } = result;
  const cs = layerRect.cellSize;
  const K = fractions.length;
  const positions = new Float32Array(lw * lh * 3);
  const uvs = new Float32Array(lw * lh * 2);
  const nb = new Float32Array(lw * lh * 4);
  const sink = new Float32Array(lw * lh);
  const g = (c: number, r: number): number => layerGround[Math.min(lh - 1, Math.max(0, r)) * lw + Math.min(lw - 1, Math.max(0, c))] as number;
  // 頂点の位置は外接矩形の北西の角からの相対値（原点から遠くても float32 の精度を保つ）
  for (let r = 0; r < lh; r++) {
    for (let c = 0; c < lw; c++) {
      const i = r * lw + c;
      positions[i * 3] = (c + 0.5) * cs;
      positions[i * 3 + 1] = g(c, r);
      positions[i * 3 + 2] = (r + 0.5) * cs;
      uvs[i * 2] = (c + 0.5) / lw;
      uvs[i * 2 + 1] = (r + 0.5) / lh;
      nb[i * 4] = g(c + 1, r);
      nb[i * 4 + 1] = g(c - 1, r);
      nb[i * 4 + 2] = g(c, r + 1);
      nb[i * 4 + 3] = g(c, r - 1);
      let m = Infinity;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) m = Math.min(m, g(c + dc, r + dr));
      sink[i] = m;
    }
  }
  // 最終の厚さが offset を超える頂点を含む四角形だけを張る
  const last = result.layers.subarray((K - 1) * lw * lh);
  // 半精度の正の値は、符号なし整数としての大小が値の大小と一致する
  const offsetHalf = DataUtils.toHalfFloat(offset);
  const index: number[] = [];
  for (let r = 0; r < lh - 1; r++) {
    for (let c = 0; c < lw - 1; c++) {
      const a = r * lw + c;
      const b = a + 1;
      const d = a + lw;
      const e = d + 1;
      const mx = Math.max(last[a]!, last[b]!, last[d]!, last[e]!);
      if (mx <= offsetHalf) continue;
      index.push(a, d, b, b, d, e);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('aNb', new BufferAttribute(nb, 4));
  geometry.setAttribute('aSink', new BufferAttribute(sink, 1));
  geometry.setIndex(index);
  const light = new Vector3(-300, 600, 400).normalize();
  const material = new ShaderMaterial({
    uniforms: {
      uSurf: { value: texture },
      uStage: { value: new Vector3(0, 0, 0) },
      uOffset: { value: offset },
      uTexel: { value: [1 / lw, 1 / lh] },
      uCell: { value: cs },
      uColor: { value: new Color(color) },
      uLight: { value: light },
    },
    vertexShader: SHELL_VERTEX,
    fragmentShader: SHELL_FRAGMENT,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'PileShell';
  mesh.position.set(layerRect.x0, 0, layerRect.z0);
  mesh.frustumCulled = false;
  return {
    mesh,
    triangles: index.length / 3,
    setStage(stage) {
      (material.uniforms.uStage!.value as Vector3).set(stage.k0, stage.k1, stage.mix);
      // まだ何も積もっていない間は描かない
      mesh.visible = stage.k0 > 0 || stage.mix > 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}
