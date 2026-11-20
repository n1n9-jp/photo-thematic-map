/**
 * PLATEAU 航空写真（PLATEAU-Ortho の XYZ タイル）を、国土地理院の標高で起伏を付けた地面として貼るレイヤー。
 *
 * - 座標は CLAUDE.md の規約どおり latLonToLocal で置く（Y=標高）。
 * - 四分木でカメラからの距離に応じたズームを選ぶ。子タイルが全部そろうまでは親タイルを表示する。
 * - 子タイルの有無は親タイル画像の透明部分（撮影範囲外・海域）から判断し、存在しないタイルは
 *   要求しない（404 をコンソールに出さない）。標高タイルも同様に、親の標高が無効値だけの範囲は要求しない。
 */
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { GSI_DEM10_MAX_ZOOM, GSI_DEM5A_ZOOM, PLATEAU_ORTHO_MAX_ZOOM, PLATEAU_ORTHO_URL } from '../../config';
import { latLonToLocal, localToLatLon } from '../../geo/enu';
import { latToTileY, lonToTileX, tileBounds, tileXToLon, tileYToLat } from '../../geo/tiles';
import type { TileBounds } from '../../geo/tiles';
import { GsiElevationSource, fetchImagePixels, hasValidHeights, sampleDemAt } from './elevation';
import type { DemKind, DemTile } from './elevation';

export interface PlateauGroundOptions {
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** カメラの真下からこの半径(m)の範囲に地面を敷く。既定 6000。 */
  radiusM?: number;
  /** 最も粗いズーム。既定 10。 */
  minZoom?: number;
  /** 最も細かいズーム。既定 19（PLATEAU-Ortho の最大）。 */
  maxZoom?: number;
  /** 画像 1 画素を画面上で何 px まで引き伸ばしてよいか。大きいほど粗いタイルで済ませる。既定 1.5。 */
  texelScale?: number;
  /** 同時に読み込むタイル数。既定 12。 */
  concurrency?: number;
  /** 保持するタイル数の上限。既定 400。 */
  maxTiles?: number;
}

type NodeState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface GroundNode {
  z: number;
  x: number;
  y: number;
  parent: GroundNode | null;
  bounds: TileBounds;
  /** ローカル座標の範囲（Y は読み込み後に確定）。 */
  box: Box3;
  sizeM: number;
  state: NodeState;
  mesh: Mesh | null;
  /** 子タイル（北西・北東・南西・南東）が存在するか。読み込み後に確定。 */
  childAvailable: [boolean, boolean, boolean, boolean] | null;
  children: (GroundNode | null)[] | null;
  /** 細かい順の標高タイル（自分で取得したもの → 祖先のもの）。 */
  dems: DemTile[];
  lastUsed: number;
}

const SEGMENTS = 16;
const SETTLE_FRAMES = 10;
const IMG = 256;

function orthoUrl(z: number, x: number, y: number): string {
  return PLATEAU_ORTHO_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** 子の並び順（北西・北東・南西・南東）に対応する (dx, dy)。 */
const CHILD_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

export class PlateauGround {
  readonly group = new Group();
  /** 初回の読み込みが終わると解決する。 */
  readonly ready: Promise<void>;
  isReady = false;
  /** 標高の参照（ほかのレイヤーが地面の高さを知るのにも使える）。 */
  readonly elevation = new GsiElevationSource();

  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly radiusM: number;
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly texelScale: number;
  private readonly concurrency: number;
  private readonly maxTiles: number;
  private readonly roots = new Map<string, GroundNode>();
  private readonly loaded = new Set<GroundNode>();
  private readonly frustum = new Frustum();
  private readonly projScreen = new Matrix4();
  private readonly camPos = new Vector3();
  private readonly size = new Vector2();
  private readonly anisotropy: number;
  private frame = 0;
  private loadingCount = 0;
  private settledFrames = 0;
  private resolveReady!: () => void;
  private disposed = false;

  constructor(options: PlateauGroundOptions) {
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.radiusM = options.radiusM ?? 6000;
    this.minZoom = options.minZoom ?? 10;
    this.maxZoom = Math.min(options.maxZoom ?? PLATEAU_ORTHO_MAX_ZOOM, PLATEAU_ORTHO_MAX_ZOOM);
    this.texelScale = options.texelScale ?? 1.5;
    this.concurrency = options.concurrency ?? 12;
    this.maxTiles = options.maxTiles ?? 400;
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.group.name = 'plateau-ground';
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** 毎フレーム、描画の前に呼ぶ。 */
  update(): void {
    if (this.disposed) return;
    this.frame++;
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    const visible = new Set<GroundNode>();
    const wanted: GroundNode[] = [];
    for (const root of this.currentRoots()) this.select(root, visible, wanted);

    for (const node of this.loaded) {
      if (node.mesh) node.mesh.visible = visible.has(node);
    }

    // 粗い順・近い順に読み込む
    wanted.sort((a, b) => a.z - b.z || this.distanceTo(a) - this.distanceTo(b));
    for (const node of wanted) {
      if (this.loadingCount >= this.concurrency) break;
      void this.load(node);
    }
    this.evict();

    if (!this.isReady) {
      const busy = wanted.length > 0 || this.loadingCount > 0;
      this.settledFrames = busy ? 0 : this.settledFrames + 1;
      if (this.settledFrames >= SETTLE_FRAMES) {
        this.isReady = true;
        this.resolveReady();
      }
    }
  }

  /** 表示中・読み込み中のタイルがあれば true。 */
  get isLoading(): boolean {
    return this.loadingCount > 0;
  }

  /** 読み込み済みタイル数。 */
  get tileCount(): number {
    return this.loaded.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const node of this.loaded) this.unload(node);
    this.loaded.clear();
    this.group.removeFromParent();
  }

  /** カメラ真下の地点を中心とする円に掛かる最も粗いズームのタイル。 */
  private currentRoots(): GroundNode[] {
    const z = this.minZoom;
    const r = this.radiusM;
    const nw = localToLatLon({ x: this.camPos.x - r, y: 0, z: this.camPos.z - r });
    const se = localToLatLon({ x: this.camPos.x + r, y: 0, z: this.camPos.z + r });
    const x0 = Math.floor(lonToTileX(nw.lon, z));
    const x1 = Math.floor(lonToTileX(se.lon, z));
    const y0 = Math.floor(latToTileY(nw.lat, z));
    const y1 = Math.floor(latToTileY(se.lat, z));
    const out: GroundNode[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${z}/${x}/${y}`;
        let node = this.roots.get(key);
        if (!node) {
          node = this.createNode(z, x, y, null);
          this.roots.set(key, node);
        }
        out.push(node);
      }
    }
    return out;
  }

  private createNode(z: number, x: number, y: number, parent: GroundNode | null): GroundNode {
    const bounds = tileBounds(z, x, y);
    const a = latLonToLocal({ lat: bounds.north, lon: bounds.west });
    const b = latLonToLocal({ lat: bounds.south, lon: bounds.east });
    const minY = parent ? parent.box.min.y : -50;
    const maxY = parent ? parent.box.max.y : 400;
    const box = new Box3(new Vector3(a.x, minY, a.z), new Vector3(b.x, maxY, b.z));
    return {
      z,
      x,
      y,
      parent,
      bounds,
      box,
      sizeM: b.x - a.x,
      state: 'idle',
      mesh: null,
      childAvailable: null,
      children: null,
      dems: parent ? parent.dems : [],
      lastUsed: 0,
    };
  }

  private distanceTo(node: GroundNode): number {
    return node.box.distanceToPoint(this.camPos);
  }

  private inRange(node: GroundNode): boolean {
    const p = this.camPos;
    const r = this.radiusM;
    const { min, max } = node.box;
    const dx = Math.max(min.x - p.x, 0, p.x - max.x);
    const dz = Math.max(min.z - p.z, 0, p.z - max.z);
    return dx * dx + dz * dz <= r * r;
  }

  private wantsSplit(node: GroundNode): boolean {
    if (node.z >= this.maxZoom) return false;
    this.renderer.getSize(this.size);
    const f = this.size.y / 2 / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    const d = Math.max(this.distanceTo(node), 1);
    return (node.sizeM * f) / d > IMG * this.texelScale;
  }

  private select(node: GroundNode, visible: Set<GroundNode>, wanted: GroundNode[]): void {
    if (!this.inRange(node) || !this.frustum.intersectsBox(node.box)) return;
    node.lastUsed = this.frame;
    if (node.state === 'unavailable') return;
    if (node.state !== 'ready') {
      if (node.state === 'idle') wanted.push(node);
      return;
    }
    if (this.wantsSplit(node)) {
      const kids = this.childrenOf(node).filter(
        (k): k is GroundNode =>
          k !== null && k.state !== 'unavailable' && this.inRange(k) && this.frustum.intersectsBox(k.box),
      );
      if (kids.every((k) => k.state === 'ready')) {
        for (const k of kids) this.select(k, visible, wanted);
        return;
      }
      for (const k of kids) {
        k.lastUsed = this.frame;
        if (k.state === 'idle') wanted.push(k);
      }
    }
    visible.add(node);
  }

  private childrenOf(node: GroundNode): (GroundNode | null)[] {
    if (!node.children) {
      node.children = CHILD_OFFSETS.map(([dx, dy], i) =>
        node.childAvailable?.[i] ? this.createNode(node.z + 1, node.x * 2 + dx, node.y * 2 + dy, node) : null,
      );
    }
    return node.children;
  }

  private async load(node: GroundNode): Promise<void> {
    node.state = 'loading';
    this.loadingCount++;
    try {
      const [img, ownDem] = await Promise.all([fetchImagePixels(orthoUrl(node.z, node.x, node.y)), this.loadDem(node)]);
      if (this.disposed) {
        img?.bitmap.close();
        return;
      }
      if (!img) {
        node.state = 'unavailable';
        return;
      }
      node.dems = ownDem ? [ownDem, ...(node.parent?.dems ?? [])] : (node.parent?.dems ?? []);
      node.childAvailable = quadrantsWithAlpha(img.pixels, img.bitmap.width, img.bitmap.height);
      node.mesh = this.buildMesh(node, img.bitmap);
      this.group.add(node.mesh);
      node.state = 'ready';
      this.loaded.add(node);
    } catch (err) {
      node.state = 'idle';
      console.warn('地面タイルの読み込みに失敗しました', node.z, node.x, node.y, err);
    } finally {
      this.loadingCount--;
    }
  }

  /** このタイルのために新たに取得する標高タイル。親の標高に有効値が無い範囲は取得しない。 */
  private async loadDem(node: GroundNode): Promise<DemTile | null> {
    const { z, x, y, parent } = node;
    let kind: DemKind;
    if (z <= GSI_DEM10_MAX_ZOOM) kind = 'dem10';
    else if (z === GSI_DEM5A_ZOOM) kind = 'dem5a';
    else return null;
    const parentDem = parent?.dems[0];
    if (parent) {
      if (!parentDem || parentDem.z !== z - 1) return null;
      const half = IMG / 2;
      const ox = (x - parent.x * 2) * half;
      const oy = (y - parent.y * 2) * half;
      if (!hasValidHeights(parentDem, ox, oy, ox + half, oy + half)) return null;
    }
    return this.elevation.getTile(kind, z, x, y);
  }

  private heightAt(dems: readonly DemTile[], lat: number, lon: number): number {
    for (const dem of dems) {
      const h = sampleDemAt(dem, lat, lon);
      if (!Number.isNaN(h)) return h;
    }
    return 0;
  }

  private buildMesh(node: GroundNode, bitmap: ImageBitmap): Mesh {
    const n = SEGMENTS;
    const center = latLonToLocal({
      lat: tileYToLat(node.y + 0.5, node.z),
      lon: tileXToLon(node.x + 0.5, node.z),
    });
    const skirt = Math.max(2, node.sizeM * 0.02);
    const gridCount = (n + 1) * (n + 1);
    const ringCount = 4 * n;
    const pos = new Float32Array((gridCount + ringCount) * 3);
    const uv = new Float32Array((gridCount + ringCount) * 2);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let j = 0; j <= n; j++) {
      const lat = tileYToLat(node.y + j / n, node.z);
      for (let i = 0; i <= n; i++) {
        const lon = tileXToLon(node.x + i / n, node.z);
        const h = this.heightAt(node.dems, lat, lon);
        const p = latLonToLocal({ lat, lon, alt: h });
        const k = j * (n + 1) + i;
        pos[k * 3] = p.x - center.x;
        pos[k * 3 + 1] = p.y;
        pos[k * 3 + 2] = p.z - center.z;
        uv[k * 2] = i / n;
        uv[k * 2 + 1] = j / n;
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
    // 外周（時計回り: 上辺→右辺→下辺→左辺）を下に垂らしたスカート。隣のタイルとの段差の隙間を隠す。
    const ring: number[] = [];
    for (let i = 0; i < n; i++) ring.push(i);
    for (let j = 0; j < n; j++) ring.push(j * (n + 1) + n);
    for (let i = n; i > 0; i--) ring.push(n * (n + 1) + i);
    for (let j = n; j > 0; j--) ring.push(j * (n + 1));
    ring.forEach((src, r) => {
      const k = gridCount + r;
      pos[k * 3] = pos[src * 3] ?? 0;
      pos[k * 3 + 1] = (pos[src * 3 + 1] ?? 0) - skirt;
      pos[k * 3 + 2] = pos[src * 3 + 2] ?? 0;
      uv[k * 2] = uv[src * 2] ?? 0;
      uv[k * 2 + 1] = uv[src * 2 + 1] ?? 0;
    });

    const index: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + n + 1;
        const c = a + 1;
        const d = b + 1;
        index.push(a, b, c, c, b, d);
      }
    }
    for (let r = 0; r < ringCount; r++) {
      const t0 = ring[r] ?? 0;
      const t1 = ring[(r + 1) % ringCount] ?? 0;
      const b0 = gridCount + r;
      const b1 = gridCount + ((r + 1) % ringCount);
      index.push(t0, b0, t1, t1, b0, b1);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(pos, 3));
    geometry.setAttribute('uv', new BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();

    const texture = new Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;

    const material = new MeshBasicMaterial({ map: texture, side: DoubleSide, alphaTest: 0.5 });
    const mesh = new Mesh(geometry, material);
    mesh.name = `ground ${node.z}/${node.x}/${node.y}`;
    mesh.position.set(center.x, 0, center.z);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;

    node.box.min.y = minY - skirt;
    node.box.max.y = maxY;
    return mesh;
  }

  private evict(): void {
    if (this.loaded.size <= this.maxTiles) return;
    const candidates = [...this.loaded].filter((n) => n.lastUsed < this.frame).sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = this.loaded.size - this.maxTiles;
    for (const node of candidates) {
      if (excess <= 0) break;
      this.unload(node);
      this.loaded.delete(node);
      excess--;
    }
  }

  private unload(node: GroundNode): void {
    const mesh = node.mesh;
    if (mesh) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      const material = mesh.material as MeshBasicMaterial;
      const image = material.map?.image as ImageBitmap | undefined;
      material.map?.dispose();
      material.dispose();
      image?.close();
    }
    node.mesh = null;
    node.state = 'idle';
  }
}

/** RGBA 画素の 4 つの象限（北西・北東・南西・南東）それぞれに不透明な画素があるか。 */
export function quadrantsWithAlpha(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): [boolean, boolean, boolean, boolean] {
  const out: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  const hw = width / 2;
  const hh = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) > 0) {
        out[(y < hh ? 0 : 2) + (x < hw ? 0 : 1)] = true;
      }
    }
  }
  return out;
}
