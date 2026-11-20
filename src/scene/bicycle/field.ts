/**
 * 大量の自転車をインスタンス描画する。
 *
 * - インスタンスごとの姿勢（位置・四元数）と色を `setInstances` で受け取る。差し替えると表示が更新される。
 * - インスタンスは空間セル（既定 6m 立方）に分けて並べ替えて保持する。
 * - 毎フレーム `update(camera, viewportHeightPx)` で、セルごとに視錐台判定とカメラ距離から詳細度を決め、
 *   3つの詳細度それぞれの InstancedBufferGeometry に連続領域としてコピーする（割り当てが変わったときだけ）。
 * - 詳細度の切り替え距離は「自転車の全長が画面上で何ピクセルになるか」から求める（`lodSwitchDistances`）。
 *
 * シェーダーは MeshLambertMaterial を onBeforeCompile で拡張し、頂点を四元数で回して平行移動する。
 * 頂点属性 frameMask=1 の部分だけインスタンスのフレーム色を掛け、全体に陰影係数（shade）を掛ける。
 */
import {
  DoubleSide,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  Vector3,
  type BufferGeometry,
  type PerspectiveCamera,
} from 'three';
import { createBicycleGeometry, triangleCount, type BicycleLod } from './geometry';

/** インスタンスの入力データ。 */
export interface BicycleInstances {
  count: number;
  /** 位置（ローカル座標 m）。長さ 3N。 */
  positions: Float32Array;
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
  /** 空間セルの一辺(m)。 */
  cellSize?: number;
  /** 近景・中景に回す台数の上限。超えた分はカメラから遠いセルから一段粗くする。 */
  maxInstancesPerLod?: readonly [number, number];
}

export interface BicycleFieldStats {
  /** 入力の総台数。 */
  total: number;
  /** 描画対象（視錐台内）の台数。 */
  visible: number;
  /** 詳細度ごとの描画台数。 */
  perLod: [number, number, number];
  /** 詳細度ごとの1台あたり三角形数。 */
  trianglesPerInstance: readonly [number, number, number];
  /** 今回の割り当てで描く三角形の総数。 */
  triangles: number;
  /** 割り当てを作り直した回数（累計）。 */
  rebuilds: number;
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

const DEFAULT_THRESHOLDS: readonly [number, number] = [90, 22];
const DEFAULT_CELL = 6;
const DEFAULT_MAX: readonly [number, number] = [2500, 20000];
/** セル境界球に足す自転車1台ぶんの半径。 */
const BIKE_RADIUS = 1.0;

/** sRGB(0-255) → 線形(0-255) の変換表。 */
const SRGB_TO_LINEAR = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const l = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    t[i] = Math.round(l * 255);
  }
  return t;
})();

function createBicycleMaterial(): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iColor;
attribute float frameMask;
vec3 bikeRotate(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}`,
      )
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = bikeRotate(iQuat, objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = bikeRotate(iQuat, transformed) + iPos;')
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
vColor.rgb = color * mix(vec3(1.0), iColor.rgb, frameMask) * iColor.a;`,
      );
  };
  mat.customProgramCacheKey = () => 'bicycle-instanced-v1';
  return mat;
}

interface LodLayer {
  base: BufferGeometry;
  geometry: InstancedBufferGeometry;
  mesh: Mesh;
  pos: InstancedBufferAttribute;
  quat: InstancedBufferAttribute;
  color: InstancedBufferAttribute;
  triangles: number;
}

/** 大量の自転車を詳細度つきでインスタンス描画するオブジェクト。 */
export class BicycleField {
  /** シーンに加えるルート。 */
  readonly object = new Group();
  readonly material = createBicycleMaterial();

  private readonly thresholds: readonly [number, number];
  private readonly cellSize: number;
  private readonly maxPerLod: readonly [number, number];
  private readonly layers: LodLayer[];

  // セルで並べ替えた入力
  private sortedPos = new Float32Array(0);
  private sortedQuat = new Float32Array(0);
  private sortedColor = new Uint8Array(0);
  private cellStart = new Uint32Array(0);
  private cellCount = new Uint32Array(0);
  private cellSphere: Sphere[] = [];
  private cellLod = new Int8Array(0);
  private cellFloor = new Int8Array(0);
  private nextLod = new Int8Array(0);
  private cellOrder: number[] = [];
  private cellDist = new Float32Array(0);
  private dirty = true;

  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly camPos = new Vector3();

  readonly stats: BicycleFieldStats;
  /** 確認用: 指定すると距離に関係なく全台をこの詳細度で描く（上限も無視）。null で通常動作。 */
  forceLod: BicycleLod | null = null;

  constructor(options: BicycleFieldOptions = {}) {
    this.thresholds = options.lodPixelThresholds ?? DEFAULT_THRESHOLDS;
    this.cellSize = options.cellSize ?? DEFAULT_CELL;
    this.maxPerLod = options.maxInstancesPerLod ?? DEFAULT_MAX;
    this.object.name = 'BicycleField';
    this.layers = ([0, 1, 2] as const).map((lod) => this.createLayer(lod, 1));
    this.stats = {
      total: 0,
      visible: 0,
      perLod: [0, 0, 0],
      trianglesPerInstance: [this.layers[0]!.triangles, this.layers[1]!.triangles, this.layers[2]!.triangles],
      triangles: 0,
      rebuilds: 0,
    };
  }

  private createLayer(lod: BicycleLod, capacity: number, base?: BufferGeometry): LodLayer {
    const b = base ?? createBicycleGeometry(lod);
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(b.getIndex());
    for (const name of ['position', 'normal', 'color', 'frameMask']) {
      geometry.setAttribute(name, b.getAttribute(name));
    }
    const cap = Math.max(1, capacity);
    const pos = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const quat = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const color = new InstancedBufferAttribute(new Uint8Array(cap * 4), 4, true);
    for (const a of [pos, quat, color]) a.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iPos', pos);
    geometry.setAttribute('iQuat', quat);
    geometry.setAttribute('iColor', color);
    geometry.instanceCount = 0;
    const mesh = new Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    mesh.name = `BicycleLOD${lod}`;
    mesh.visible = false;
    this.object.add(mesh);
    return { base: b, geometry, mesh, pos, quat, color, triangles: triangleCount(b) };
  }

  /** インスタンスの姿勢と色を差し替える。 */
  setInstances(data: BicycleInstances): void {
    const n = data.count;
    // 1. セル番号
    const cs = this.cellSize;
    const keys = new Map<string, number>();
    const cellOf = new Uint32Array(n);
    const centers: number[] = [];
    const floors: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = data.positions[i * 3]!;
      const y = data.positions[i * 3 + 1]!;
      const z = data.positions[i * 3 + 2]!;
      const cx = Math.floor(x / cs);
      const cy = Math.floor(y / cs);
      const cz = Math.floor(z / cs);
      const floor = data.lodFloor ? Math.min(3, data.lodFloor[i]!) : 0;
      const key = `${cx},${cy},${cz},${floor}`;
      let id = keys.get(key);
      if (id === undefined) {
        id = keys.size;
        keys.set(key, id);
        centers.push((cx + 0.5) * cs, (cy + 0.5) * cs, (cz + 0.5) * cs);
        floors.push(floor);
      }
      cellOf[i] = id;
    }
    const cells = keys.size;
    // 2. 計数ソート
    const count = new Uint32Array(cells);
    for (let i = 0; i < n; i++) count[cellOf[i]!]!++;
    const start = new Uint32Array(cells);
    for (let c = 1; c < cells; c++) start[c] = start[c - 1]! + count[c - 1]!;
    const fill = start.slice();
    const sp = new Float32Array(n * 3);
    const sq = new Float32Array(n * 4);
    const sc = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const j = fill[cellOf[i]!]!++;
      sp[j * 3] = data.positions[i * 3]!;
      sp[j * 3 + 1] = data.positions[i * 3 + 1]!;
      sp[j * 3 + 2] = data.positions[i * 3 + 2]!;
      for (let k = 0; k < 4; k++) sq[j * 4 + k] = data.quaternions[i * 4 + k]!;
      sc[j * 4] = SRGB_TO_LINEAR[data.colors[i * 3]!]!;
      sc[j * 4 + 1] = SRGB_TO_LINEAR[data.colors[i * 3 + 1]!]!;
      sc[j * 4 + 2] = SRGB_TO_LINEAR[data.colors[i * 3 + 2]!]!;
      sc[j * 4 + 3] = data.shades ? data.shades[i]! : 255;
    }
    // 3. セルの境界球（セル内の実際の位置から）
    const spheres: Sphere[] = [];
    for (let c = 0; c < cells; c++) {
      const center = new Vector3(centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!);
      let r2 = 0;
      for (let j = start[c]!; j < start[c]! + count[c]!; j++) {
        const dx = sp[j * 3]! - center.x;
        const dy = sp[j * 3 + 1]! - center.y;
        const dz = sp[j * 3 + 2]! - center.z;
        r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
      }
      spheres.push(new Sphere(center, Math.sqrt(r2) + BIKE_RADIUS));
    }

    this.sortedPos = sp;
    this.sortedQuat = sq;
    this.sortedColor = sc;
    this.cellStart = start;
    this.cellCount = count;
    this.cellSphere = spheres;
    this.cellFloor = Int8Array.from(floors);
    this.cellLod = new Int8Array(cells).fill(-2);
    this.nextLod = new Int8Array(cells);
    this.cellOrder = Array.from({ length: cells }, (_, i) => i);
    this.cellDist = new Float32Array(cells);
    this.stats.total = n;

    // 各詳細度の容量を確保し直す（上限があれば上限まで）
    // 最も近いセルは上限を超えても受け入れるので、最大セルの台数ぶんの余裕を足す
    const maxCell = count.reduce((a, b) => Math.max(a, b), 0);
    const caps =
      this.forceLod !== null
        ? [n, n, n]
        : [Math.min(n, this.maxPerLod[0] + maxCell), Math.min(n, this.maxPerLod[1] + maxCell), n];
    this.layers.forEach((layer, lod) => {
      if (layer.pos.count < caps[lod]! || layer.pos.count > caps[lod]! * 2 + 1024) {
        this.object.remove(layer.mesh);
        layer.geometry.dispose();
        this.layers[lod] = this.createLayer(lod as BicycleLod, caps[lod]!, layer.base);
      }
    });
    this.dirty = true;
  }

  /** カメラに応じて詳細度の割り当てを更新する。描画前に毎フレーム呼ぶ。 */
  update(camera: PerspectiveCamera, viewportHeightPx: number): void {
    const cells = this.cellSphere.length;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    camera.getWorldPosition(this.camPos);
    const sw = lodSwitchDistances(camera.fov / camera.zoom, viewportHeightPx, this.thresholds);

    // 視錐台外は -1、それ以外は距離で仮決め
    for (let c = 0; c < cells; c++) {
      const s = this.cellSphere[c]!;
      const floor = this.cellFloor[c]!;
      if (floor >= 3 || !this.frustum.intersectsSphere(s)) {
        this.nextLod[c] = -1;
        this.cellDist[c] = Infinity;
        continue;
      }
      const d = Math.max(0, s.center.distanceTo(this.camPos) - s.radius);
      this.cellDist[c] = d;
      this.nextLod[c] = this.forceLod ?? Math.max(floor, selectLod(d, sw));
    }
    // 上限を超えたら遠いセルから一段粗くする
    const dist = this.cellDist;
    this.cellOrder.sort((a, b) => dist[a]! - dist[b]! || 0); // Infinity 同士の NaN は 0 とみなす
    const used = [0, 0];
    for (const c of this.cellOrder) {
      let lod = this.nextLod[c]!;
      if (lod < 0 || this.forceLod !== null) break;
      while (lod < 2 && used[lod]! > 0 && used[lod]! + this.cellCount[c]! > this.maxPerLod[lod]!) lod++;
      if (lod < 2) used[lod]! += this.cellCount[c]!;
      this.nextLod[c] = lod;
    }

    let changed = this.dirty;
    if (!changed) {
      for (let c = 0; c < cells; c++) {
        if (this.nextLod[c] !== this.cellLod[c]) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    this.cellLod.set(this.nextLod);
    this.dirty = false;
    this.rebuild();
  }

  private rebuild(): void {
    const filled = [0, 0, 0];
    for (const c of this.cellOrder) {
      const lod = this.cellLod[c]!;
      if (lod < 0) continue;
      const layer = this.layers[lod]!;
      const s = this.cellStart[c]!;
      const n = this.cellCount[c]!;
      const o = filled[lod]!;
      if (o + n > layer.pos.count) continue;
      (layer.pos.array as Float32Array).set(this.sortedPos.subarray(s * 3, (s + n) * 3), o * 3);
      (layer.quat.array as Float32Array).set(this.sortedQuat.subarray(s * 4, (s + n) * 4), o * 4);
      (layer.color.array as Uint8Array).set(this.sortedColor.subarray(s * 4, (s + n) * 4), o * 4);
      filled[lod] = o + n;
    }
    let tris = 0;
    this.layers.forEach((layer, lod) => {
      const n = filled[lod]!;
      layer.geometry.instanceCount = n;
      layer.mesh.visible = n > 0;
      for (const [a, size] of [[layer.pos, 3], [layer.quat, 4], [layer.color, 4]] as const) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * size);
        a.needsUpdate = true;
      }
      tris += n * layer.triangles;
    });
    this.stats.perLod = [filled[0]!, filled[1]!, filled[2]!];
    this.stats.visible = filled[0]! + filled[1]! + filled[2]!;
    this.stats.triangles = tris;
    this.stats.rebuilds++;
  }

  dispose(): void {
    for (const layer of this.layers) {
      layer.geometry.dispose();
      layer.base.dispose();
    }
    this.material.dispose();
    this.object.removeFromParent();
  }
}
