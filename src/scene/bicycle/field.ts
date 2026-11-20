/**
 * 大量の自転車をインスタンス描画する。
 *
 * - 自転車は「まとまり」（駅ごと、山ごと）単位で `addGroup` に登録する。まとまりの中の登録順が出現の順位になり、
 *   `setRevealCount(n, group)` で「先頭の n 台だけを表示する」。切り替えはシェーダーで行い、バッファは作り直さない。
 * - インスタンスは空間セル（既定 6m 立方）にまとめ、さらにセルを区画（既定 4km 四方）に分ける。
 *   区画ごとに基準点を `Object3D.position` に置き、インスタンスの位置は基準点からの相対値で GPU に渡す
 *   （`modelViewMatrix` は CPU の倍精度で計算されるので、原点から遠くても打ち消し合いの誤差が出ない）。
 * - 遠景の層は、区画の全インスタンスを固定の並びで GPU に常駐させる。セルごとの表示・非表示はセル状態テクスチャ
 *   （1セル1バイト）と描画範囲（区画ごとに最大4つ）で表すので、カメラが動いてもインスタンスは送り直さない。
 * - 近景と中景の層（上限 数千〜2万台）だけ、割り当てが変わったときにカメラ近くの基準点からの相対値で作り直す。
 * - 詳細度の切り替え距離は「自転車の全長が画面上で何ピクセルになるか」から求め（`lodSwitchDistances`）、
 *   閾値の前後に余裕幅（既定 ±15%）を設けて、閾値付近での行き来を防ぐ。
 *
 * シェーダーは MeshLambertMaterial を onBeforeCompile で拡張し、頂点を四元数で回して平行移動する。
 * 頂点属性 frameMask=1 の部分だけインスタンスのフレーム色（sRGB で受け取りシェーダーで線形に変換）を掛け、
 * 全体に陰影係数（shade）を掛ける。
 */
import {
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  FloatType,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  RedFormat,
  StaticDrawUsage,
  UnsignedByteType,
  Vector3,
  type BufferGeometry,
  type PerspectiveCamera,
} from 'three';
import { createBicycleGeometry, triangleCount, type BicycleLod } from './geometry';

/** インスタンスの入力データ（1つのまとまり）。 */
export interface BicycleInstances {
  count: number;
  /**
   * 位置（m）。`origin` からの相対値。長さ 3N。
   * 原点から遠い場所では、`origin` に近くの基準点を指定するか、Float64Array で渡して精度を保つ。
   */
  positions: Float32Array | Float64Array;
  /** `positions` の基準点（ローカル座標 m、倍精度）。省略時は (0, 0, 0)。 */
  origin?: { x: number; y: number; z: number };
  /** 回転の四元数 (x, y, z, w)。長さ 4N。 */
  quaternions: Float32Array;
  /** フレーム色（sRGB 0-255）。長さ 3N。 */
  colors: Uint8Array;
  /** 全体の明るさ係数（0-255、255=そのまま）。山の内部を暗くするのに使う。省略時は 255。長さ N。 */
  shades?: Uint8Array;
  /**
   * 詳細度の下限（0-2）または 3=描画しない。長さ N。省略時はすべて 0。
   * 山の内部に埋もれて外から見えない自転車を、遠景用に固定したり描画から外したりするのに使う。
   */
  lodFloor?: Uint8Array;
}

export interface BicycleFieldOptions {
  /**
   * 詳細度を上げる画面上の全長(px)。[近景, 中景]。
   * 自転車の全長がこれ以上の大きさに見えるセルは近景、次の値以上は中景、それ未満は遠景。
   */
  lodPixelThresholds?: readonly [number, number];
  /** 詳細度の切り替え距離に設ける余裕幅（割合）。細かくするときは距離×(1-h)、粗くするときは距離×(1+h) で切り替える。 */
  lodHysteresis?: number;
  /** 空間セルの一辺(m)。 */
  cellSize?: number;
  /** 区画の一辺(m)。区画ごとに基準点を置き、位置を基準点からの相対値で GPU に渡す。 */
  regionSize?: number;
  /** 近景・中景に回す台数の上限。超えた分はカメラから遠いセルから一段粗くする。 */
  maxInstancesPerLod?: readonly [number, number];
}

export interface BicycleFieldStats {
  /** 登録した総台数（全まとまりの合計、lodFloor=3 を含む）。 */
  total: number;
  /** 表示する台数（`setRevealCount` を反映した合計、lodFloor=3 を含む）。 */
  revealed: number;
  /** 描画対象（表示する台数のうち視錐台内のセルにあるもの）の台数。 */
  visible: number;
  /** 詳細度ごとの描画台数（表示する台数のうち）。 */
  perLod: [number, number, number];
  /** 詳細度ごとの1台あたり三角形数。 */
  trianglesPerInstance: readonly [number, number, number];
  /** 描く三角形の総数。 */
  triangles: number;
  /** 近景・中景の層を作り直した回数（累計）。 */
  rebuilds: number;
  /** GPU へ転送したバイト数（累計）。インスタンスのバッファとセル状態・表示台数のテクスチャを含む。 */
  uploadBytes: number;
  /** 直近の `update` で転送するバイト数（その前の `setRevealCount` 等の分を含む）。 */
  frameUploadBytes: number;
  /** 容量を超えて描画できなかった台数。 */
  overflow: number;
  /** 自転車の描画呼び出し数。 */
  drawCalls: number;
  /** 登録したまとまりの数。 */
  groups: number;
}

/** 自転車の全長(m)。距離計算に使う。 */
export const BIKE_LENGTH_M = 1.8;

/**
 * 詳細度の切り替え距離(m)を求める。
 * 全長 lengthM の物体が画面上で thresholdPx になる距離 = lengthM * f / thresholdPx、
 * f = viewportHeightPx / (2 tan(fov/2)) はピクセル単位の焦点距離。
 */
export function lodSwitchDistances(
  fovDeg: number,
  viewportHeightPx: number,
  thresholdsPx: readonly [number, number],
  lengthM = BIKE_LENGTH_M,
): [number, number] {
  const f = viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  return [(lengthM * f) / thresholdsPx[0], (lengthM * f) / thresholdsPx[1]];
}

/** 距離と切り替え距離から詳細度を選ぶ。 */
export function selectLod(distance: number, switchDistances: readonly [number, number]): BicycleLod {
  if (distance < switchDistances[0]) return 0;
  if (distance < switchDistances[1]) return 1;
  return 2;
}

/**
 * 余裕幅つきで詳細度を選ぶ。prev は直前の詳細度（未定なら負の値）。
 * 細かくするのは距離が切り替え距離×(1-margin) を下回ったとき、粗くするのは×(1+margin) を上回ったとき。
 */
export function selectLodWithHysteresis(
  distance: number,
  switchDistances: readonly [number, number],
  prev: number,
  margin: number,
): BicycleLod {
  if (prev < 0 || prev > 2) return selectLod(distance, switchDistances);
  const fine = selectLod(distance, [switchDistances[0] * (1 - margin), switchDistances[1] * (1 - margin)]);
  const coarse = selectLod(distance, [switchDistances[0] * (1 + margin), switchDistances[1] * (1 + margin)]);
  // coarse <= fine。prev がその間なら据え置く
  if (prev < coarse) return coarse;
  if (prev > fine) return fine;
  return prev as BicycleLod;
}

let boundingRadiusCache: number | null = null;
/** 形状の原点から最も遠い頂点までの距離（全詳細度の最大）に余裕を足した半径(m)。視錐台の判定に使う。 */
export function bicycleBoundingRadius(): number {
  if (boundingRadiusCache === null) {
    let r = 0;
    for (const lod of [0, 1, 2] as const) {
      const geo = createBicycleGeometry(lod);
      r = Math.max(r, maxVertexDistance(geo));
      geo.dispose();
    }
    boundingRadiusCache = r * 1.05 + 0.05;
  }
  return boundingRadiusCache;
}

/** 形状の原点から最も遠い頂点までの距離。 */
export function maxVertexDistance(geo: BufferGeometry): number {
  const p = geo.getAttribute('position');
  let r2 = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    r2 = Math.max(r2, x * x + y * y + z * z);
  }
  return Math.sqrt(r2);
}

const DEFAULT_THRESHOLDS: readonly [number, number] = [90, 22];
const DEFAULT_HYSTERESIS = 0.15;
const DEFAULT_CELL = 6;
const DEFAULT_REGION = 4000;
const DEFAULT_MAX: readonly [number, number] = [2500, 20000];
/** 近景・中景の層の容量の上限（これを超えた分は描かずに stats.overflow に数える）。 */
const MAX_DYNAMIC_CAPACITY = 1 << 22;
/** 遠景の描画範囲の数（区画ごと）。 */
const FAR_RANGES = 4;
/** 遠景の描画範囲を分けるのに必要な隙間の台数。これより短い隙間はつないでシェーダーで消す。 */
const FAR_SPLIT_GAP = 2048;
/** インスタンスの float の並び: 位置3, 四元数4, 順位, まとまり, セル。 */
const STRIDE = 10;
/** 1台あたりの GPU 上のバイト数（float 10個 + 色4バイト）。 */
const BYTES_PER_INSTANCE = STRIDE * 4 + 4;
const MASK_WIDTH = 2048;
const REVEAL_WIDTH = 1024;

const VERTEX_HEADER = `#include <common>
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iColor;
attribute vec3 iMeta;
attribute float frameMask;
uniform highp sampler2D uCellMask;
uniform highp sampler2D uReveal;
uniform int uMaskWidth;
uniform int uRevealWidth;
vec3 bikeRotate(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
vec3 bikeSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}`;

const VERTEX_HIDE = `#include <project_vertex>
{
  int bikeCell = int(iMeta.z + 0.5);
  int bikeGroup = int(iMeta.y + 0.5);
  float bikeMask = texelFetch(uCellMask, ivec2(bikeCell % uMaskWidth, bikeCell / uMaskWidth), 0).r;
  float bikeReveal = texelFetch(uReveal, ivec2(bikeGroup % uRevealWidth, bikeGroup / uRevealWidth), 0).r;
  if (bikeMask < 0.5 || iMeta.x >= bikeReveal) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

interface FieldUniforms {
  uCellMask: { value: DataTexture };
  uReveal: { value: DataTexture };
  uMaskWidth: { value: number };
  uRevealWidth: { value: number };
}

function createBicycleMaterial(uniforms: FieldUniforms): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERTEX_HEADER)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = bikeRotate(iQuat, objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = bikeRotate(iQuat, transformed) + iPos;')
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
vColor.rgb = color * mix(vec3(1.0), bikeSrgbToLinear(iColor.rgb), frameMask) * iColor.a;`,
      )
      .replace('#include <project_vertex>', VERTEX_HIDE);
  };
  mat.customProgramCacheKey = () => 'bicycle-instanced-v2';
  return mat;
}

function createDataTexture(data: Uint8Array | Float32Array, width: number, height: number): DataTexture {
  const tex = new DataTexture(data, width, height, RedFormat, data instanceof Float32Array ? FloatType : UnsignedByteType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** 形状の属性を持つ InstancedBufferGeometry を作る（インスタンス属性は呼び出し側で足す）。 */
function instancedFromBase(base: BufferGeometry): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(base.getIndex());
  for (const name of ['position', 'normal', 'color', 'frameMask']) {
    geometry.setAttribute(name, base.getAttribute(name));
  }
  geometry.instanceCount = 0;
  return geometry;
}

interface GroupEntry {
  id: number;
  data: BicycleInstances;
  reveal: number;
  /** 構築時のテクスチャ上の番号。 */
  slot: number;
}

interface FarRange {
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  start: number;
  count: number;
}

interface Region {
  anchor: Vector3;
  center: Vector3;
  radius: number;
  cellBegin: number;
  cellEnd: number;
  instances: number;
  f32: Float32Array;
  u8: Uint8Array;
  fbuf: InstancedInterleavedBuffer;
  cbuf: InstancedInterleavedBuffer;
  ranges: FarRange[];
  dirty: boolean;
}

interface DynamicLayer {
  lod: 0 | 1;
  geometry: InstancedBufferGeometry;
  mesh: Mesh;
  pos: InstancedBufferAttribute;
  quat: InstancedBufferAttribute;
  meta: InstancedBufferAttribute;
  color: InstancedBufferAttribute;
  capacity: number;
  count: number;
}

/** 16ビットの整数の各ビットの間に0を挟む（Morton 符号用）。 */
function spreadBits(v: number): number {
  let x = v & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x >>> 0;
}

/** 大量の自転車を詳細度つきでインスタンス描画するオブジェクト。 */
export class BicycleField {
  /** シーンに加えるルート。 */
  readonly object = new Group();
  readonly material: MeshLambertMaterial;
  readonly stats: BicycleFieldStats;

  private readonly thresholds: readonly [number, number];
  private readonly hysteresis: number;
  private readonly cellSize: number;
  private readonly regionSize: number;
  private readonly maxPerLod: readonly [number, number];
  private readonly bikeRadius = bicycleBoundingRadius();
  private readonly bases: [BufferGeometry, BufferGeometry, BufferGeometry];
  private readonly triangles: [number, number, number];
  private readonly uniforms: FieldUniforms;
  private readonly dynamic: [DynamicLayer, DynamicLayer];

  private readonly groups = new Map<number, GroupEntry>();
  private nextGroupId = 0;
  private structureDirty = true;
  private forceLodValue: BicycleLod | null = null;
  private assignDirty = true;

  // 構築結果
  private regions: Region[] = [];
  private cells = 0;
  private cellRegion = new Int32Array(0);
  private cellStart = new Uint32Array(0);
  private cellCount = new Uint32Array(0);
  private cellGroup = new Int32Array(0);
  private cellFloor = new Int8Array(0);
  private cellSphere = new Float64Array(0); // x, y, z, r
  private cellLod = new Int8Array(0);
  private nextLod = new Int8Array(0);
  private cellDist = new Float64Array(0);
  private cellRevealed = new Uint32Array(0);
  /** まとまりごとのセルの一覧（CSR）。 */
  private groupCellStart = new Uint32Array(0);
  private groupCellList = new Uint32Array(0);
  private groupBySlot: GroupEntry[] = [];
  private maskData = new Uint8Array(4);
  private revealData = new Float32Array(4);
  private revealDirtySlots = new Set<number>();
  private pendingUpload = 0;
  private candidates: number[] = [];

  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly invObject = new Matrix4();
  private readonly camPos = new Vector3();

  constructor(options: BicycleFieldOptions = {}) {
    this.thresholds = options.lodPixelThresholds ?? DEFAULT_THRESHOLDS;
    this.hysteresis = options.lodHysteresis ?? DEFAULT_HYSTERESIS;
    this.cellSize = options.cellSize ?? DEFAULT_CELL;
    this.regionSize = options.regionSize ?? DEFAULT_REGION;
    this.maxPerLod = options.maxInstancesPerLod ?? DEFAULT_MAX;
    this.object.name = 'BicycleField';
    this.bases = [createBicycleGeometry(0), createBicycleGeometry(1), createBicycleGeometry(2)];
    this.triangles = [triangleCount(this.bases[0]), triangleCount(this.bases[1]), triangleCount(this.bases[2])];
    this.uniforms = {
      uCellMask: { value: createDataTexture(this.maskData, 4, 1) },
      uReveal: { value: createDataTexture(this.revealData, 4, 1) },
      uMaskWidth: { value: 4 },
      uRevealWidth: { value: 4 },
    };
    this.material = createBicycleMaterial(this.uniforms);
    this.dynamic = [this.createDynamicLayer(0, 256), this.createDynamicLayer(1, 1024)];
    this.stats = {
      total: 0,
      revealed: 0,
      visible: 0,
      perLod: [0, 0, 0],
      trianglesPerInstance: this.triangles,
      triangles: 0,
      rebuilds: 0,
      uploadBytes: 0,
      frameUploadBytes: 0,
      overflow: 0,
      drawCalls: 0,
      groups: 0,
    };
  }

  /** 確認用: 指定すると距離に関係なく全台をこの詳細度で描く（上限も無視）。null で通常動作。 */
  get forceLod(): BicycleLod | null {
    return this.forceLodValue;
  }
  set forceLod(lod: BicycleLod | null) {
    if (lod === this.forceLodValue) return;
    this.forceLodValue = lod;
    // 割り当てをすべて決め直す（近景・中景の容量は作り直しのときに必要なだけ確保し直す）
    this.assignDirty = true;
  }

  /**
   * まとまり（駅ごと、山ごと）を登録し、その番号を返す。登録した順が出現の順位になる。
   * 表示する台数の初期値は全台。配列は登録後に書き換えないこと（次の構築で読み直す）。
   * 構築は次の `update` でまとめて行うので、最初にすべてのまとまりを登録してから `update` を呼ぶ。
   */
  addGroup(data: BicycleInstances, options: { reveal?: number } = {}): number {
    const id = this.nextGroupId++;
    const reveal = clampInt(options.reveal ?? data.count, 0, data.count);
    this.groups.set(id, { id, data, reveal, slot: -1 });
    this.structureDirty = true;
    return id;
  }

  /** まとまりを取り除く。 */
  removeGroup(id: number): void {
    if (this.groups.delete(id)) this.structureDirty = true;
  }

  /** すべてのまとまりを取り除く。 */
  clear(): void {
    this.groups.clear();
    this.structureDirty = true;
  }

  /** すべてのまとまりを取り除き、1つのまとまりとして登録し直す（番号を返す）。 */
  setInstances(data: BicycleInstances): number {
    this.clear();
    return this.addGroup(data);
  }

  /**
   * まとまりの先頭（登録順）の n 台だけを表示する。group を省略するとすべてのまとまりに同じ n を使う。
   * バッファは作り直さず、まとまりごとの表示台数（4バイト）をテクスチャで送るだけ。
   */
  setRevealCount(n: number, group?: number): void {
    const targets = group === undefined ? [...this.groups.values()] : [this.groups.get(group)];
    for (const g of targets) {
      if (!g) continue;
      const reveal = clampInt(n, 0, g.data.count);
      if (reveal === g.reveal) continue;
      g.reveal = reveal;
      if (g.slot >= 0 && !this.structureDirty) {
        this.revealData[g.slot] = reveal;
        this.revealDirtySlots.add(g.slot);
      }
    }
    this.updateRevealedTotal();
  }

  /** まとまりの表示台数。 */
  getRevealCount(group: number): number {
    return this.groups.get(group)?.reveal ?? 0;
  }

  /** カメラに応じて詳細度の割り当てを更新する。描画前に毎フレーム呼ぶ。 */
  update(camera: PerspectiveCamera, viewportHeightPx: number): void {
    if (this.structureDirty) this.build();
    this.flushReveal();

    camera.updateMatrixWorld();
    this.object.updateWorldMatrix(true, false);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.object.matrixWorld);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.invObject.copy(this.object.matrixWorld).invert();
    camera.getWorldPosition(this.camPos).applyMatrix4(this.invObject);
    const sw = lodSwitchDistances(camera.fov / camera.zoom, viewportHeightPx, this.thresholds);
    const force = this.forceLodValue;
    const reset = this.assignDirty;
    this.assignDirty = false;

    // 1. 視錐台の判定と距離による詳細度（視錐台外は -1）
    const sphere = this.cellSphere;
    const cand = this.candidates;
    cand.length = 0;
    for (const r of this.regions) {
      const regionIn = this.sphereInFrustum(r.center.x, r.center.y, r.center.z, r.radius);
      for (let c = r.cellBegin; c < r.cellEnd; c++) {
        const x = sphere[c * 4]!;
        const y = sphere[c * 4 + 1]!;
        const z = sphere[c * 4 + 2]!;
        const rad = sphere[c * 4 + 3]!;
        if (!regionIn || !this.sphereInFrustum(x, y, z, rad)) {
          this.nextLod[c] = -1;
          continue;
        }
        const d = Math.max(0, Math.hypot(x - this.camPos.x, y - this.camPos.y, z - this.camPos.z) - rad);
        this.cellDist[c] = d;
        let lod: number;
        if (force !== null) lod = force;
        else {
          const prev = reset ? -1 : this.cellLod[c]!;
          lod = Math.max(this.cellFloor[c]!, selectLodWithHysteresis(d, sw, prev, this.hysteresis));
          if (lod < 2) cand.push(c);
        }
        this.nextLod[c] = lod;
      }
    }
    // 2. 近景・中景の上限を超えたら遠いセルから一段粗くする
    if (force === null && cand.length > 0) {
      const dist = this.cellDist;
      cand.sort((a, b) => dist[a]! - dist[b]!);
      const used = [0, 0];
      for (const c of cand) {
        let lod = this.nextLod[c]!;
        const n = this.cellCount[c]!;
        while (lod < 2 && used[lod]! > 0 && used[lod]! + n > this.maxPerLod[lod]!) lod++;
        if (lod < 2) used[lod]! += n;
        this.nextLod[c] = lod;
      }
    }
    // 3. 変化の検出（セル状態テクスチャはここで書き換える）
    let nearChanged = reset;
    let midChanged = reset;
    let maskChanged = false;
    for (let c = 0; c < this.cells; c++) {
      const prev = this.cellLod[c]!;
      const next = this.nextLod[c]!;
      if (prev === next) continue;
      if (prev === 0 || next === 0) nearChanged = true;
      if (prev === 1 || next === 1) midChanged = true;
      if ((prev === 2) !== (next === 2)) {
        this.maskData[c + 1] = next === 2 ? 255 : 0;
        maskChanged = true;
        this.regions[this.cellRegion[c]!]!.dirty = true;
      }
      this.cellLod[c] = next;
    }
    if (maskChanged) {
      this.uniforms.uCellMask.value.needsUpdate = true;
      this.pendingUpload += this.maskData.byteLength;
    }
    if (nearChanged) this.rebuildDynamic(this.dynamic[0]);
    if (midChanged) this.rebuildDynamic(this.dynamic[1]);
    if (nearChanged || midChanged) this.stats.rebuilds++;
    for (const r of this.regions) if (r.dirty) this.updateFarRanges(r);

    // 4. 統計
    const perLod: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < this.cells; c++) {
      const lod = this.cellLod[c]!;
      if (lod >= 0) perLod[lod]! += this.cellRevealed[c]!;
    }
    let drawCalls = 0;
    for (const layer of this.dynamic) if (layer.mesh.visible) drawCalls++;
    for (const r of this.regions) for (const rg of r.ranges) if (rg.mesh.visible) drawCalls++;
    const s = this.stats;
    s.perLod = perLod;
    s.visible = perLod[0] + perLod[1] + perLod[2];
    s.triangles = perLod[0] * this.triangles[0] + perLod[1] * this.triangles[1] + perLod[2] * this.triangles[2];
    s.drawCalls = drawCalls;
    s.overflow = Math.max(0, this.dynamic[0].count - this.dynamic[0].capacity) + Math.max(0, this.dynamic[1].count - this.dynamic[1].capacity);
    s.frameUploadBytes = this.pendingUpload;
    s.uploadBytes += this.pendingUpload;
    this.pendingUpload = 0;
  }

  /** 確認用: セルの一覧（境界球、台数、表示する台数、詳細度。-1 は描かない）。 */
  debugCells(): { center: [number, number, number]; radius: number; count: number; revealed: number; lod: number }[] {
    if (this.structureDirty) this.build();
    this.flushReveal();
    const out = [];
    for (let c = 0; c < this.cells; c++) {
      out.push({
        center: [this.cellSphere[c * 4]!, this.cellSphere[c * 4 + 1]!, this.cellSphere[c * 4 + 2]!] as [number, number, number],
        radius: this.cellSphere[c * 4 + 3]!,
        count: this.cellCount[c]!,
        revealed: this.cellRevealed[c]!,
        lod: this.cellLod[c]!,
      });
    }
    return out;
  }

  dispose(): void {
    this.disposeRegions();
    for (const layer of this.dynamic) layer.geometry.dispose();
    for (const b of this.bases) b.dispose();
    this.uniforms.uCellMask.value.dispose();
    this.uniforms.uReveal.value.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }

  // ---- 内部 ----

  private sphereInFrustum(x: number, y: number, z: number, r: number): boolean {
    for (const p of this.frustum.planes) {
      if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant < -r) return false;
    }
    return true;
  }

  private createDynamicLayer(lod: 0 | 1, capacity: number): DynamicLayer {
    const geometry = instancedFromBase(this.bases[lod]);
    const pos = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const quat = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const meta = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const color = new InstancedBufferAttribute(new Uint8Array(capacity * 4), 4, true);
    for (const a of [pos, quat, meta, color]) a.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iPos', pos);
    geometry.setAttribute('iQuat', quat);
    geometry.setAttribute('iMeta', meta);
    geometry.setAttribute('iColor', color);
    const mesh = new Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.name = `BicycleLOD${lod}`;
    this.object.add(mesh);
    return { lod, geometry, mesh, pos, quat, meta, color, capacity, count: 0 };
  }

  private flushReveal(): void {
    if (this.revealDirtySlots.size === 0) return;
    for (const slot of this.revealDirtySlots) {
      for (let k = this.groupCellStart[slot]!; k < this.groupCellStart[slot + 1]!; k++) {
        const c = this.groupCellList[k]!;
        this.cellRevealed[c] = this.revealedInCell(c);
        this.regions[this.cellRegion[c]!]!.dirty = true;
      }
    }
    this.revealDirtySlots.clear();
    this.uniforms.uReveal.value.needsUpdate = true;
    this.pendingUpload += this.revealData.byteLength;
    this.updateRevealedTotal();
  }

  private updateRevealedTotal(): void {
    let revealed = 0;
    for (const g of this.groups.values()) revealed += g.reveal;
    this.stats.revealed = revealed;
  }

  /** セルの中で順位が表示台数未満のインスタンスの数（セル内は順位の昇順に並んでいる）。 */
  private revealedInCell(c: number): number {
    const reveal = this.groupBySlot[this.cellGroup[c]!]!.reveal;
    const f = this.regions[this.cellRegion[c]!]!.f32;
    let lo = this.cellStart[c]!;
    let hi = lo + this.cellCount[c]!;
    const begin = lo;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (f[mid * STRIDE + 7]! < reveal) lo = mid + 1;
      else hi = mid;
    }
    return lo - begin;
  }

  private disposeRegions(): void {
    for (const r of this.regions) {
      for (const rg of r.ranges) {
        this.object.remove(rg.mesh);
        rg.geometry.dispose();
      }
    }
    this.regions = [];
  }

  /** 登録されたまとまりからセル・区画・常駐バッファを作る。 */
  private build(): void {
    this.structureDirty = false;
    this.assignDirty = true;
    this.revealDirtySlots.clear();
    this.disposeRegions();
    const cs = this.cellSize;
    const groups = [...this.groups.values()];
    groups.forEach((g, slot) => (g.slot = slot));
    this.groupBySlot = groups;

    // 1. セル（まとまり・詳細度の下限ごと）に分ける
    const cellGroupL: number[] = [];
    const cellFloorL: number[] = [];
    const cellXL: number[] = [];
    const cellYL: number[] = [];
    const cellZL: number[] = [];
    const bbox: number[] = []; // minx, miny, minz, maxx, maxy, maxz
    const countL: number[] = [];
    const instCell: Int32Array[] = [];
    let total = 0;
    for (const g of groups) {
      const d = g.data;
      const n = d.count;
      total += n;
      const ox = d.origin?.x ?? 0;
      const oy = d.origin?.y ?? 0;
      const oz = d.origin?.z ?? 0;
      const keys = new Map<number, number>();
      const ic = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const floor = d.lodFloor ? Math.min(3, d.lodFloor[i]!) : 0;
        if (floor >= 3) {
          ic[i] = -1;
          continue;
        }
        const x = ox + d.positions[i * 3]!;
        const y = oy + d.positions[i * 3 + 1]!;
        const z = oz + d.positions[i * 3 + 2]!;
        const cx = Math.floor(x / cs);
        const cy = Math.floor(y / cs);
        const cz = Math.floor(z / cs);
        const key = (((cx + 32768) * 4096 + (cy + 2048)) * 65536 + (cz + 32768)) * 4 + floor;
        let id = keys.get(key);
        if (id === undefined) {
          id = countL.length;
          keys.set(key, id);
          cellGroupL.push(g.slot);
          cellFloorL.push(floor);
          cellXL.push(cx);
          cellYL.push(cy);
          cellZL.push(cz);
          countL.push(0);
          bbox.push(x, y, z, x, y, z);
        }
        countL[id]!++;
        const b = id * 6;
        if (x < bbox[b]!) bbox[b] = x;
        if (y < bbox[b + 1]!) bbox[b + 1] = y;
        if (z < bbox[b + 2]!) bbox[b + 2] = z;
        if (x > bbox[b + 3]!) bbox[b + 3] = x;
        if (y > bbox[b + 4]!) bbox[b + 4] = y;
        if (z > bbox[b + 5]!) bbox[b + 5] = z;
        ic[i] = id;
      }
      instCell.push(ic);
    }
    const cells = countL.length;

    // 2. 区画を決め、セルを（区画, まとまり, Morton 順, 高さ）で並べる
    const R = this.regionSize;
    const regionKeys = new Map<string, number>();
    const rawRegion = new Int32Array(cells);
    for (let c = 0; c < cells; c++) {
      const key = `${Math.floor((cellXL[c]! * cs) / R)},${Math.floor((cellZL[c]! * cs) / R)}`;
      let id = regionKeys.get(key);
      if (id === undefined) {
        id = regionKeys.size;
        regionKeys.set(key, id);
      }
      rawRegion[c] = id;
    }
    const morton = new Float64Array(cells);
    for (let c = 0; c < cells; c++) {
      morton[c] = (spreadBits(cellXL[c]! + 32768) | (spreadBits(cellZL[c]! + 32768) << 1)) >>> 0;
    }
    const order = Array.from({ length: cells }, (_, i) => i);
    order.sort(
      (a, b) =>
        rawRegion[a]! - rawRegion[b]! ||
        cellGroupL[a]! - cellGroupL[b]! ||
        morton[a]! - morton[b]! ||
        cellYL[a]! - cellYL[b]! ||
        cellFloorL[a]! - cellFloorL[b]!,
    );
    const newIndex = new Int32Array(cells);
    order.forEach((old, i) => (newIndex[old] = i));

    // 3. セルの配列（並べ替え後）
    this.cells = cells;
    this.cellRegion = new Int32Array(cells);
    this.cellStart = new Uint32Array(cells);
    this.cellCount = new Uint32Array(cells);
    this.cellGroup = new Int32Array(cells);
    this.cellFloor = new Int8Array(cells);
    this.cellSphere = new Float64Array(cells * 4);
    this.cellLod = new Int8Array(cells).fill(-1);
    this.nextLod = new Int8Array(cells);
    this.cellDist = new Float64Array(cells);
    this.cellRevealed = new Uint32Array(cells);
    const regionCount = regionKeys.size;
    const regionBox = new Float64Array(regionCount * 6);
    for (let r = 0; r < regionCount; r++) regionBox.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], r * 6);
    const regionCells = new Uint32Array(regionCount + 1);
    const regionInst = new Uint32Array(regionCount);
    for (let i = 0; i < cells; i++) {
      const old = order[i]!;
      const r = rawRegion[old]!;
      this.cellRegion[i] = r;
      this.cellGroup[i] = cellGroupL[old]!;
      this.cellFloor[i] = cellFloorL[old]!;
      const n = countL[old]!;
      this.cellCount[i] = n;
      this.cellStart[i] = regionInst[r]!;
      regionInst[r]! += n;
      regionCells[r + 1]!++;
      const b = old * 6;
      const hx = (bbox[b + 3]! - bbox[b]!) / 2;
      const hy = (bbox[b + 4]! - bbox[b + 1]!) / 2;
      const hz = (bbox[b + 5]! - bbox[b + 2]!) / 2;
      this.cellSphere[i * 4] = bbox[b]! + hx;
      this.cellSphere[i * 4 + 1] = bbox[b + 1]! + hy;
      this.cellSphere[i * 4 + 2] = bbox[b + 2]! + hz;
      this.cellSphere[i * 4 + 3] = Math.hypot(hx, hy, hz) + this.bikeRadius;
      for (let k = 0; k < 3; k++) {
        regionBox[r * 6 + k] = Math.min(regionBox[r * 6 + k]!, bbox[b + k]!);
        regionBox[r * 6 + 3 + k] = Math.max(regionBox[r * 6 + 3 + k]!, bbox[b + 3 + k]!);
      }
    }
    for (let r = 0; r < regionCount; r++) regionCells[r + 1]! += regionCells[r]!;

    // 4. 区画ごとの常駐バッファ（基準点からの相対位置）
    let upload = 0;
    this.regions = [];
    for (let r = 0; r < regionCount; r++) {
      const b = r * 6;
      const center = new Vector3((regionBox[b]! + regionBox[b + 3]!) / 2, (regionBox[b + 1]! + regionBox[b + 4]!) / 2, (regionBox[b + 2]! + regionBox[b + 5]!) / 2);
      const radius = Math.hypot(regionBox[b + 3]! - regionBox[b]!, regionBox[b + 4]! - regionBox[b + 1]!, regionBox[b + 5]! - regionBox[b + 2]!) / 2 + this.bikeRadius;
      // 基準点は 1m 単位に丸める（確認しやすさのため。精度には影響しない）
      const anchor = new Vector3(Math.round(center.x), Math.round(center.y), Math.round(center.z));
      const n = regionInst[r]!;
      const f32 = new Float32Array(Math.max(1, n) * STRIDE);
      const u8 = new Uint8Array(Math.max(1, n) * 4);
      const fbuf = new InstancedInterleavedBuffer(f32, STRIDE, 1).setUsage(StaticDrawUsage);
      const cbuf = new InstancedInterleavedBuffer(u8, 4, 1).setUsage(StaticDrawUsage);
      upload += f32.byteLength + u8.byteLength;
      const ranges: FarRange[] = [];
      for (let k = 0; k < FAR_RANGES; k++) {
        const geometry = instancedFromBase(this.bases[2]);
        const mesh = new Mesh(geometry, this.material);
        mesh.frustumCulled = false;
        mesh.visible = false;
        mesh.name = `BicycleLOD2-r${r}-${k}`;
        mesh.position.copy(anchor);
        this.object.add(mesh);
        ranges.push({ mesh, geometry, start: -1, count: 0 });
      }
      this.regions.push({ anchor, center, radius, cellBegin: regionCells[r]!, cellEnd: regionCells[r + 1]!, instances: n, f32, u8, fbuf, cbuf, ranges, dirty: true });
    }
    const fill = Uint32Array.from(this.cellStart);
    groups.forEach((g, slot) => {
      const d = g.data;
      const ic = instCell[slot]!;
      const ox = d.origin?.x ?? 0;
      const oy = d.origin?.y ?? 0;
      const oz = d.origin?.z ?? 0;
      for (let i = 0; i < d.count; i++) {
        const old = ic[i]!;
        if (old < 0) continue;
        const c = newIndex[old]!;
        const region = this.regions[this.cellRegion[c]!]!;
        const o = fill[c]!++;
        const f = region.f32;
        const a = region.anchor;
        const p = o * STRIDE;
        f[p] = ox - a.x + d.positions[i * 3]!;
        f[p + 1] = oy - a.y + d.positions[i * 3 + 1]!;
        f[p + 2] = oz - a.z + d.positions[i * 3 + 2]!;
        f[p + 3] = d.quaternions[i * 4]!;
        f[p + 4] = d.quaternions[i * 4 + 1]!;
        f[p + 5] = d.quaternions[i * 4 + 2]!;
        f[p + 6] = d.quaternions[i * 4 + 3]!;
        f[p + 7] = i;
        f[p + 8] = slot;
        f[p + 9] = c + 1;
        const u = region.u8;
        u[o * 4] = d.colors[i * 3]!;
        u[o * 4 + 1] = d.colors[i * 3 + 1]!;
        u[o * 4 + 2] = d.colors[i * 3 + 2]!;
        u[o * 4 + 3] = d.shades ? d.shades[i]! : 255;
      }
    });

    // 5. まとまりごとのセルの一覧
    this.groupCellStart = new Uint32Array(groups.length + 1);
    for (let c = 0; c < cells; c++) this.groupCellStart[this.cellGroup[c]! + 1]!++;
    for (let s = 0; s < groups.length; s++) this.groupCellStart[s + 1]! += this.groupCellStart[s]!;
    this.groupCellList = new Uint32Array(cells);
    const gfill = this.groupCellStart.slice();
    for (let c = 0; c < cells; c++) this.groupCellList[gfill[this.cellGroup[c]!]!++] = c;

    // 6. テクスチャ（セル状態: 0番は近景・中景用に常に 255。表示台数: まとまりごと）
    const maskW = Math.min(MASK_WIDTH, nextPow2(Math.max(4, cells + 1)));
    const maskH = Math.ceil((cells + 1) / maskW);
    this.maskData = new Uint8Array(maskW * maskH);
    this.maskData[0] = 255;
    this.uniforms.uCellMask.value.dispose();
    this.uniforms.uCellMask.value = createDataTexture(this.maskData, maskW, maskH);
    this.uniforms.uMaskWidth.value = maskW;
    const revW = Math.min(REVEAL_WIDTH, nextPow2(Math.max(4, groups.length)));
    const revH = Math.max(1, Math.ceil(groups.length / revW));
    this.revealData = new Float32Array(revW * revH);
    groups.forEach((g) => (this.revealData[g.slot] = g.reveal));
    this.uniforms.uReveal.value.dispose();
    this.uniforms.uReveal.value = createDataTexture(this.revealData, revW, revH);
    this.uniforms.uRevealWidth.value = revW;
    upload += this.maskData.byteLength + this.revealData.byteLength;
    this.pendingUpload += upload;

    for (let c = 0; c < cells; c++) this.cellRevealed[c] = this.revealedInCell(c);
    this.stats.total = total;
    this.stats.groups = groups.length;
    this.updateRevealedTotal();
  }

  /** 近景・中景の層を、カメラ近くの基準点からの相対位置で作り直す。 */
  private rebuildDynamic(layer: DynamicLayer): void {
    let need = 0;
    for (let c = 0; c < this.cells; c++) if (this.cellLod[c] === layer.lod) need += this.cellCount[c]!;
    layer.count = need;
    const fit = Math.min(need, MAX_DYNAMIC_CAPACITY);
    let realloc = false;
    if (fit > layer.capacity) {
      // 容量を確保し直す（geometry ごと作り直して、three.js の最大インスタンス数の記録も更新する）
      const cap = Math.min(MAX_DYNAMIC_CAPACITY, nextPow2(fit));
      this.object.remove(layer.mesh);
      layer.geometry.dispose();
      const fresh = this.createDynamicLayer(layer.lod, cap);
      Object.assign(layer, fresh, { count: need });
      realloc = true;
    }
    const anchor = layer.mesh.position;
    anchor.set(Math.round(this.camPos.x), Math.round(this.camPos.y), Math.round(this.camPos.z));
    const pa = layer.pos.array as Float32Array;
    const qa = layer.quat.array as Float32Array;
    const ma = layer.meta.array as Float32Array;
    const ca = layer.color.array as Uint8Array;
    let o = 0;
    for (let c = 0; c < this.cells && o < fit; c++) {
      if (this.cellLod[c] !== layer.lod) continue;
      const region = this.regions[this.cellRegion[c]!]!;
      const dx = region.anchor.x - anchor.x;
      const dy = region.anchor.y - anchor.y;
      const dz = region.anchor.z - anchor.z;
      const f = region.f32;
      const u = region.u8;
      const end = Math.min(this.cellStart[c]! + this.cellCount[c]!, this.cellStart[c]! + (fit - o));
      for (let j = this.cellStart[c]!; j < end; j++, o++) {
        const p = j * STRIDE;
        pa[o * 3] = f[p]! + dx;
        pa[o * 3 + 1] = f[p + 1]! + dy;
        pa[o * 3 + 2] = f[p + 2]! + dz;
        qa[o * 4] = f[p + 3]!;
        qa[o * 4 + 1] = f[p + 4]!;
        qa[o * 4 + 2] = f[p + 5]!;
        qa[o * 4 + 3] = f[p + 6]!;
        ma[o * 3] = f[p + 7]!;
        ma[o * 3 + 1] = f[p + 8]!;
        ma[o * 3 + 2] = 0; // セル状態テクスチャの0番（常に表示）
        ca[o * 4] = u[j * 4]!;
        ca[o * 4 + 1] = u[j * 4 + 1]!;
        ca[o * 4 + 2] = u[j * 4 + 2]!;
        ca[o * 4 + 3] = u[j * 4 + 3]!;
      }
    }
    layer.geometry.instanceCount = o;
    layer.mesh.visible = o > 0;
    for (const [a, size] of [[layer.pos, 3], [layer.quat, 4], [layer.meta, 3], [layer.color, 4]] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, o) * size);
      a.needsUpdate = true;
    }
    this.pendingUpload += (realloc ? layer.capacity : o) * BYTES_PER_INSTANCE;
  }

  /** 遠景で描くセルを覆う描画範囲（最大 FAR_RANGES 個）を決める。インスタンスは送り直さない。 */
  private updateFarRanges(r: Region): void {
    r.dirty = false;
    // 遠景で描く（表示する台数が1台以上の）セルの連続した並び
    const runs: [number, number][] = [];
    for (let c = r.cellBegin; c < r.cellEnd; c++) {
      if (this.cellLod[c] !== 2 || this.cellRevealed[c] === 0) continue;
      const s = this.cellStart[c]!;
      const e = s + this.cellCount[c]!;
      const last = runs[runs.length - 1];
      if (last && last[1] === s) last[1] = e;
      else runs.push([s, e]);
    }
    // 大きな隙間だけで分け、残りはつなぐ（つないだ隙間のセルはシェーダーで消える）
    const gaps = runs.slice(1).map((run, i) => ({ i, size: run[0] - runs[i]![1] }));
    const splits = new Set(
      gaps
        .filter((g) => g.size >= FAR_SPLIT_GAP)
        .sort((a, b) => b.size - a.size)
        .slice(0, FAR_RANGES - 1)
        .map((g) => g.i),
    );
    const merged: [number, number][] = [];
    runs.forEach((run, i) => {
      if (i > 0 && !splits.has(i - 1)) merged[merged.length - 1]![1] = run[1];
      else merged.push([run[0], run[1]]);
    });
    r.ranges.forEach((rg, k) => {
      const m = merged[k];
      if (!m) {
        rg.mesh.visible = false;
        return;
      }
      const [start, end] = m;
      if (rg.start !== start) {
        // 同じ常駐バッファを、先頭をずらした属性で参照する（転送は発生しない）
        rg.geometry.setAttribute('iPos', new InterleavedBufferAttribute(r.fbuf, 3, start * STRIDE));
        rg.geometry.setAttribute('iQuat', new InterleavedBufferAttribute(r.fbuf, 4, start * STRIDE + 3));
        rg.geometry.setAttribute('iMeta', new InterleavedBufferAttribute(r.fbuf, 3, start * STRIDE + 7));
        rg.geometry.setAttribute('iColor', new InterleavedBufferAttribute(r.cbuf, 4, start * 4, true));
        rg.start = start;
      }
      rg.count = end - start;
      rg.geometry.instanceCount = rg.count;
      rg.mesh.visible = rg.count > 0;
    });
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
