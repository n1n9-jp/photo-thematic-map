/**
 * 地面: 国土地理院の標高タイルで起伏を付けた、単色の面。航空写真は使わない。
 *
 * - 座標は CLAUDE.md の規約どおり latLonToLocal で置く（Y=標高）。
 * - 四分木でカメラからの距離に応じたズームを選ぶ（タイルの画面上の大きさが基準を超えたら子に分ける）。
 *   子タイルが全部そろうまでは親タイルを表示する。標高タイル（とくに 5m メッシュ）の転送量を抑えるため、浅い角度で見る
 *   タイル・霧の掛かるタイルは基準を緩め、カメラが動いている間は新しく読むタイルだけを粗くする。
 * - 各タイルには、標高から作る小さな画像（TEX×TEX 画素）を貼る。色は陸の色（`BASE_LAND_COLOR`）に、
 *   標高の傾きから求めた控えめな陰影（光の向きはシーンの太陽に近い西南西の上）を掛けたもの。
 *   標高の無効値（海）は透明にし、下に敷いた海の面（`baseGround.ts`）が見えるようにする。
 * - 子タイルの有無は親の画像の陸の範囲から判断し、海だけの範囲には地面を作らない。
 *   標高タイルも、親の標高が無効値だけの範囲は要求しない（存在しないタイルの 404 をコンソールに出さない）。
 * - 標高タイルは、ズーム14までは同じズームの 10m メッシュ、それより細かいタイルはズーム15 の 5m メッシュを取得し、
 *   さらに細かいタイルは祖先の標高を使う（新たには取得しない）。存在しない標高タイル（404。海の上）は「陸がない」とみなす。
 * - 標高タイルを取得できなかった（回線の失敗などで、再試行の上限に達した）タイルは、祖先の標高（無ければ 0m）で、
 *   無効値も海とせずに不透明な地面を作って表示し（地面が抜けて物が浮かないように）、子にも同じ扱いを引き継ぐ。
 *   `retryFailedTiles()` で、そのタイルから下を作り直す。取得の再試行と失敗の集計は `tileFetch.ts`。
 * - メモリ: 保持するタイル数に上限を設け、使っていないタイルの画像・標高の参照・木の枝を解放する。
 *   画像と UV は GPU へ転送した後に CPU 側から解放する。
 */
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Fog,
  Frustum,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { GSI_DEM10_MAX_ZOOM, GSI_DEM5A_ZOOM } from '../../config';
import { latLonToLocal, localToLatLon } from '../../geo/enu';
import { latToTileY, lonToTileX, tileBounds, tileXToLon, tileYToLat } from '../../geo/tiles';
import type { TileBounds } from '../../geo/tiles';
import { BASE_LAND_COLOR } from './baseGround';
import { plateauMemoryBudget, releaseAfterUpload } from './budget';
import { GsiElevationSource, fetchImagePixels, hasValidHeights, sampleDem } from './elevation';
import type { DemKind, DemTile, FetchPixels } from './elevation';
import { TileFetchPolicy, TileUnavailableError, reportTileFailure } from './tileFetch';
import type { TileFetchPolicyOptions } from './tileFetch';

export interface PlateauGroundOptions {
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** カメラの真下からこの半径(m)の範囲に地面を敷く。既定 6000。 */
  radiusM?: number;
  /** 最も粗いズーム。既定 10。 */
  minZoom?: number;
  /**
   * 最も細かいズーム。既定 18（1 タイル約 124m、頂点の間隔 約 7.7m、画像の 1 画素 約 1m）。標高は 5m メッシュまでなので、
   * これより細かくしても地面の形と陰影はほぼ変わらない。
   */
  maxZoom?: number;
  /**
   * タイルを子に分ける基準。タイルの画面上の大きさが TILE_PX×この値(px) を超えたら分ける。大きいほど粗いタイルで済ませる。
   * 既定は端末に合わせて plateauMemoryBudget() から選ぶ（パソコン 1.5・スマートフォン 2）。
   */
  detailScale?: number;
  /**
   * カメラが動いている間（と止まってから数フレーム）は、detailScale をこの倍率にして粗いタイルだけを新しく読む。
   * 場面のあいだの移動で通り過ぎる場所の標高タイル（5m メッシュ）を読まずに済む。1 で無効。既定 4。
   */
  movingDetailFactor?: number;
  /**
   * 霧（シーンの Fog）が掛かる距離では、霧の濃さに応じて粗いタイルで済ませる（色の差が 1−濃さ に薄まるので、
   * 必要な細かさをその割合で下げる）。下げる割合の下限。0 で無効。既定 0.25。
   */
  fogMinContrast?: number;
  /**
   * 地面を浅い角度で見るタイルは、奥行きの方向に縮んで見えるので粗いタイルで済ませる。視線と地面の角度を θ として、
   * 必要な細かさを √sinθ 倍に下げる。下げる倍率の下限。1 で無効。既定 0.25。
   */
  grazingMinFactor?: number;
  /** 同時に読み込むタイル数。既定 12。 */
  concurrency?: number;
  /** 保持するタイル数の上限。既定は端末に合わせて plateauMemoryBudget() から選ぶ（パソコン 240・スマートフォン 120）。 */
  maxTiles?: number;
  /** 最も粗いズームのタイルを作る範囲（度）。既定は制限なし。 */
  rootBounds?: { west: number; south: number; east: number; north: number };
  /** キャッシュする標高タイル数の上限。既定は plateauMemoryBudget() から選ぶ（96・48）。 */
  elevationMaxTiles?: number;
  /** 標高タイルの再試行の方針（回数・間隔）。 */
  fetchPolicy?: TileFetchPolicyOptions;
  /** 標高タイルの画像の取得（単体テストで差し替える）。既定は fetchImagePixels。 */
  fetchPixels?: FetchPixels;
}

/** unavailable: 陸がない（海だけの範囲）。 */
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
  /** 4 つの象限（北西・北東・南西・南東）に陸があるか。読み込み後に確定し、解放後も残す（子の有無の判断に使う）。 */
  land: [boolean, boolean, boolean, boolean] | null;
  children: (GroundNode | null)[] | null;
  /** 細かい順の標高タイル（自分で取得したもの → 祖先のもの）。 */
  dems: DemTile[];
  /**
   * 自分か祖先が標高タイルを取得できず、その代わりの標高で作った（不透明な地面）。読み込み後に確定する。
   * retryFailedTiles() で、このタイルから下を作り直す。
   */
  fallback: boolean;
  lastUsed: number;
}

/** タイル 1 枚の一辺の分割数（頂点の格子）。 */
const SEGMENTS = 16;
/** タイル 1 枚に貼る、陰影と陸の範囲の画像の一辺の画素数。 */
const TEX = 128;
/** 子に分ける基準の画面上の大きさ(px)。detailScale を掛ける。 */
const TILE_PX = 256;
const SETTLE_FRAMES = 10;
/** カメラがこのフレーム数止まっていれば、細かいタイルを読み始める。 */
const STILL_FRAMES = 3;
/** 1 フレームの回転がこれ(rad)を超えたら「動いている」とみなす。 */
const MOVING_ANGLE_RAD = 0.0005;
/** 使っていない木の枝を刈り込む間隔（フレーム）。 */
const PRUNE_INTERVAL = 120;
const DEM_SIZE = 256;

/**
 * 陰影の光の向き（X=東, Y=上, Z=南）。シーンの太陽（`createScene.ts` の DirectionalLight、西南西の高い位置）に合わせ、
 * 建物の明暗と地面の起伏の明暗の向きをそろえる。
 */
const LIGHT = new Vector3(-200, 400, 150).normalize();
/** 陰影の強さ。平らな面を 1 として、光に向く斜面は明るく、背く斜面は暗くする割合の上限。 */
export const RELIEF_STRENGTH = 0.16;
/** 起伏を読み取りやすくする高さの強調（傾きをこの倍にして陰影を求める。形は変えない）。 */
export const RELIEF_EXAGGERATION = 1.5;

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
  readonly elevation: GsiElevationSource;

  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  /** カメラの真下からこの半径(m)の範囲に地面を敷く。俯瞰の高さに合わせて変えてよい。 */
  radiusM: number;
  private readonly rootBounds: PlateauGroundOptions['rootBounds'];
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly detailScale: number;
  private readonly movingDetailFactor: number;
  private readonly fogMinContrast: number;
  private readonly grazingMinFactor: number;
  /** 新しく読むタイルを選ぶときの detailScale（カメラが動いている間は粗い）。表示の選び方には使わない。 */
  private requestScale = 1.5;
  private fog: Fog | null = null;
  private readonly prevPos = new Vector3(Number.NaN, 0, 0);
  private readonly prevQuat = new Quaternion();
  /** カメラが止まってからのフレーム数。 */
  private stillFrames = STILL_FRAMES;
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
    this.rootBounds = options.rootBounds;
    this.minZoom = options.minZoom ?? 10;
    this.maxZoom = options.maxZoom ?? 18;
    const budget = plateauMemoryBudget();
    this.detailScale = options.detailScale ?? budget.groundDetailScale;
    this.movingDetailFactor = Math.max(1, options.movingDetailFactor ?? 4);
    this.fogMinContrast = Math.min(Math.max(options.fogMinContrast ?? 0.25, 0), 1);
    this.grazingMinFactor = Math.min(Math.max(options.grazingMinFactor ?? 0.25, 0.01), 1);
    this.requestScale = this.detailScale;
    this.concurrency = options.concurrency ?? 12;
    this.maxTiles = options.maxTiles ?? budget.groundMaxTiles;
    this.elevation = new GsiElevationSource({
      fetchPixels: options.fetchPixels ?? fetchImagePixels,
      maxTiles: options.elevationMaxTiles ?? budget.elevationMaxTiles,
      policy: new TileFetchPolicy('標高', options.fetchPolicy),
    });
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
    this.trackMotion(cam);
    this.fog = findFog(this.group);

    const visible = new Set<GroundNode>();
    const wanted: GroundNode[] = [];
    const roots = this.currentRoots();
    for (const root of roots) this.select(root, visible, wanted);

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
    if (this.frame % PRUNE_INTERVAL === 0) this.prune(new Set(roots));

    if (!this.isReady) {
      const busy = wanted.length > 0 || this.loadingCount > 0 || this.cameraSettling;
      this.settledFrames = busy ? 0 : this.settledFrames + 1;
      if (this.settledFrames >= SETTLE_FRAMES) {
        this.isReady = true;
        this.resolveReady();
      }
    }
  }

  /** 読み込み中のタイルがあれば true。 */
  get isLoading(): boolean {
    return this.loadingCount > 0;
  }

  /**
   * 読み込み中か、カメラが動いている（止まったら細かいタイルを読む）ので update() を呼び続けてほしいなら true。
   * 描画を必要なフレームだけ行う呼び出し側は、これが true の間は update() を呼ぶ。
   */
  get needsUpdate(): boolean {
    return this.loadingCount > 0 || this.cameraSettling;
  }

  /** カメラが動いている、または止まってまだ数フレーム。 */
  private get cameraSettling(): boolean {
    return this.movingDetailFactor > 1 && this.stillFrames < STILL_FRAMES;
  }

  /** カメラの動きを前のフレームと比べ、新しく読むタイルの細かさ（requestScale）を決める。 */
  private trackMotion(cam: PerspectiveCamera): void {
    const q = cam.getWorldQuaternion(new Quaternion());
    if (!Number.isNaN(this.prevPos.x)) {
      // 高いところほど大きく動いても見え方は変わらないので、許す移動量を高さに比例させる
      const tol = Math.max(0.02, Math.abs(this.camPos.y) * 0.001);
      const moved = this.camPos.distanceTo(this.prevPos) > tol || q.angleTo(this.prevQuat) > MOVING_ANGLE_RAD;
      this.stillFrames = moved ? 0 : this.stillFrames + 1;
    }
    this.prevPos.copy(this.camPos);
    this.prevQuat.copy(q);
    this.requestScale = this.cameraSettling ? this.detailScale * this.movingDetailFactor : this.detailScale;
  }

  /** 読み込み済みタイル数。 */
  get tileCount(): number {
    return this.loaded.size;
  }

  /** 読み込み済みのタイル（確認用。単体テストが表示中のタイルを調べる）。 */
  debugTiles(): { z: number; x: number; y: number; visible: boolean }[] {
    return [...this.loaded].map((n) => ({ z: n.z, x: n.x, y: n.y, visible: n.mesh?.visible ?? false }));
  }

  /** 取得できなかった標高タイルの数。 */
  get failedElevationTileCount(): number {
    return this.elevation.failedTileCount;
  }

  /**
   * 標高タイルを取得できなかったタイルを、次のフレームから取り直す（配信サーバーに再び接続できたときなど）。
   * 代わりの標高で作ったタイル（fallback）から下を捨てて作り直す。作り直すまでは、親のタイルが表示される。
   */
  retryFailedTiles(): void {
    this.elevation.policy.reset();
    // 取得できなかった標高タイルは失敗としてキャッシュしているので、キャッシュごと捨てる
    this.elevation.dispose();
    const drop = (node: GroundNode): void => {
      for (const child of node.children ?? []) if (child) drop(child);
      if (this.loaded.has(node)) {
        this.unload(node);
        this.loaded.delete(node);
      }
      if (node.state !== 'loading') node.state = 'idle';
      node.children = null;
      node.land = null;
      node.fallback = false;
    };
    const visit = (node: GroundNode): void => {
      if (node.fallback) {
        drop(node);
        return;
      }
      for (const child of node.children ?? []) if (child) visit(child);
    };
    for (const root of this.roots.values()) visit(root);
  }

  dispose(): void {
    this.disposed = true;
    for (const node of this.loaded) this.unload(node);
    this.loaded.clear();
    this.roots.clear();
    this.elevation.dispose();
    this.group.removeFromParent();
  }

  /** カメラ真下の地点を中心とする円に掛かる最も粗いズームのタイル。 */
  private currentRoots(): GroundNode[] {
    const z = this.minZoom;
    const r = this.radiusM;
    const nw = localToLatLon({ x: this.camPos.x - r, y: 0, z: this.camPos.z - r });
    const se = localToLatLon({ x: this.camPos.x + r, y: 0, z: this.camPos.z + r });
    let x0 = Math.floor(lonToTileX(nw.lon, z));
    let x1 = Math.floor(lonToTileX(se.lon, z));
    let y0 = Math.floor(latToTileY(nw.lat, z));
    let y1 = Math.floor(latToTileY(se.lat, z));
    const b = this.rootBounds;
    if (b) {
      x0 = Math.max(x0, Math.floor(lonToTileX(b.west, z)));
      x1 = Math.min(x1, Math.floor(lonToTileX(b.east, z)));
      y0 = Math.max(y0, Math.floor(latToTileY(b.north, z)));
      y1 = Math.min(y1, Math.floor(latToTileY(b.south, z)));
    }
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
      land: null,
      children: null,
      dems: parent ? parent.dems : [],
      fallback: false,
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

  /**
   * node より細かいタイルにしたいか（タイルの画面上の大きさが基準を超える）。scale は detailScale（表示の選び方）か
   * requestScale（新しく読むタイルの選び方）。浅い角度で見るタイルと霧の掛かるタイルは基準を緩める。
   * 表示はカメラが動いていても止まっていても同じ基準で選ぶので、読み込み済みのタイル（と地面の高さ）は移動中も変わらない。
   */
  private wantsSplit(node: GroundNode, scale: number = this.detailScale): boolean {
    if (node.z >= this.maxZoom) return false;
    this.renderer.getSize(this.size);
    const f = this.size.y / 2 / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    const d = Math.max(this.distanceTo(node), 1);
    return (node.sizeM * f * this.grazingFactor(node, d)) / d > TILE_PX * scale * this.fogRelief(d);
  }

  /** 視線と地面の角度による、必要な細かさの倍率（0〜1）。カメラよりタイルが高いときは 1。 */
  private grazingFactor(node: GroundNode, d: number): number {
    if (this.grazingMinFactor >= 1) return 1;
    const h = this.camPos.y - (node.box.min.y + node.box.max.y) / 2;
    if (h <= 0 || h >= d) return 1;
    return Math.max(Math.sqrt(h / d), this.grazingMinFactor);
  }

  /** 距離 d(m) での霧による許容の倍率（1 以上）。霧が濃いほど粗いタイルで済ませる。 */
  private fogRelief(d: number): number {
    const fog = this.fog;
    if (!fog || this.fogMinContrast <= 0 || fog.far <= fog.near) return 1;
    const t = Math.min(Math.max((d - fog.near) / (fog.far - fog.near), 0), 1);
    return 1 / Math.max(1 - t, this.fogMinContrast);
  }

  /**
   * 表示するタイルと読み込むタイルを選ぶ。読み込み済みのタイルは、細かくしたいときに子（が全部そろうまでは自分）を表示する。
   * カメラが動いている間は、表示の選び方は変えず、新しく読むタイルだけを粗くする（requestScale）。
   */
  private select(node: GroundNode, visible: Set<GroundNode>, wanted: GroundNode[]): void {
    if (!this.inView(node)) return;
    node.lastUsed = this.frame;
    if (node.state === 'unavailable') return;
    if (node.state !== 'ready') {
      if (node.state === 'idle') wanted.push(node);
      return;
    }
    if (this.wantsSplit(node)) {
      const kids = this.viewKids(node);
      if (kids.every((k) => k.state === 'ready')) {
        for (const k of kids) this.select(k, visible, wanted);
        return;
      }
      const request = !this.cameraSettling || this.wantsSplit(node, this.requestScale);
      for (const k of kids) {
        k.lastUsed = this.frame;
        if (request && k.state === 'idle') wanted.push(k);
      }
    }
    visible.add(node);
  }

  private inView(node: GroundNode): boolean {
    return this.inRange(node) && this.frustum.intersectsBox(node.box);
  }

  /** 陸があり、範囲と視野に入る子。 */
  private viewKids(node: GroundNode): GroundNode[] {
    return this.childrenOf(node).filter((k): k is GroundNode => k !== null && k.state !== 'unavailable' && this.inView(k));
  }

  private childrenOf(node: GroundNode): (GroundNode | null)[] {
    if (!node.children) {
      node.children = CHILD_OFFSETS.map(([dx, dy], q) =>
        node.land?.[q] ? this.createNode(node.z + 1, node.x * 2 + dx, node.y * 2 + dy, node) : null,
      );
    }
    return node.children;
  }

  private async load(node: GroundNode): Promise<void> {
    node.state = 'loading';
    this.loadingCount++;
    // 待っている間に親が解放されても（dems が空になる）、読み始めたときの親の標高で作る
    const parentDems = node.parent?.dems ?? [];
    const parentFallback = node.parent?.fallback ?? false;
    try {
      let ownDem: DemTile | null = null;
      let failed = false;
      try {
        ownDem = await this.loadDem(node, parentDems, parentFallback);
      } catch (err) {
        // 再試行の上限に達した（TileUnavailableError。報告は tileFetch.ts がまとめて行う）か、標高を復号できなかった
        failed = true;
        if (!(err instanceof TileUnavailableError)) reportTileFailure('標高');
      }
      if (this.disposed) return;
      node.dems = ownDem ? [ownDem, ...parentDems] : parentDems;
      node.fallback = failed || (parentFallback && !ownDem);
      // 標高がまったくない（最も粗い段から取得できなかった）ときは、0m の不透明な地面にする
      const surface = buildSurface(node.z, node.x, node.y, node.dems, TEX, node.fallback && node.dems.length === 0);
      node.land = quadrantsWithAlpha(surface.pixels, TEX, TEX);
      if (!node.land.some(Boolean)) {
        node.state = 'unavailable';
        return;
      }
      node.mesh = this.buildMesh(node, surface);
      this.group.add(node.mesh);
      node.state = 'ready';
      this.loaded.add(node);
    } finally {
      this.loadingCount--;
    }
  }

  /**
   * このタイルのために新たに取得する標高タイル（ズーム14までは同じズームの 10m メッシュ、それより細かいタイルは
   * ズーム15 の 5m メッシュ）。祖先の標高で足りる細かいタイルと、親が自分の標高を取得して有効値が無いと分かっている範囲
   * （海）は取得しない。親が代わりの標高で作られた（fallback）ときは、範囲の判断ができないので取得を試す。
   * 存在しない（404）なら null、取得できなければ TileUnavailableError を投げる。
   */
  private async loadDem(node: GroundNode, parentDems: readonly DemTile[], parentFallback: boolean): Promise<DemTile | null> {
    const { z, parent } = node;
    const zt = demZoom(z);
    const kind: DemKind = zt === GSI_DEM5A_ZOOM ? 'dem5a' : 'dem10';
    const tx = node.x >> (z - zt);
    const ty = node.y >> (z - zt);
    if (parent) {
      const ancestorDem = parentDems[0];
      if (ancestorDem && ancestorDem.z >= zt) return null;
      if (!parentFallback) {
        if (!ancestorDem || ancestorDem.z !== demZoom(parent.z)) return null;
        const scale = 2 ** (zt - ancestorDem.z);
        const size = Math.max(1, DEM_SIZE / scale);
        const ox = Math.floor((tx - ancestorDem.x * scale) * size);
        const oy = Math.floor((ty - ancestorDem.y * scale) * size);
        if (!hasValidHeights(ancestorDem, ox, oy, ox + size, oy + size)) return null;
      }
    }
    return this.elevation.loadTile(kind, zt, tx, ty);
  }

  private buildMesh(node: GroundNode, surface: GroundSurface): Mesh {
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
    const sampler = new DemSampler(node.dems, node.z, node.x, node.y, n, 0);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let j = 0; j <= n; j++) {
      const lat = tileYToLat(node.y + j / n, node.z);
      for (let i = 0; i <= n; i++) {
        const lon = tileXToLon(node.x + i / n, node.z);
        const h = sampler.at(i, j);
        const p = latLonToLocal({ lat, lon, alt: Number.isNaN(h) ? 0 : h });
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

    const texture = new DataTexture(surface.pixels, TEX, TEX, RGBAFormat, UnsignedByteType);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    // GPU へ転送したら CPU 側の画素は要らない
    texture.onUpdate = () => {
      texture.image.data = null;
      texture.onUpdate = null;
    };
    // UV もレイキャストに使わないので、転送後に解放する
    releaseAfterUpload(geometry.getAttribute('uv') as BufferAttribute);

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
      material.map?.dispose();
      material.dispose();
    }
    node.mesh = null;
    node.state = 'idle';
    // 標高タイルの参照を手放す（再び読むときに親の標高から作り直す）
    node.dems = [];
  }

  /**
   * 使っていない木の枝を刈り込む。読み込み済み・読み込み中のタイルを含まない枝は、
   * 子の配列ごと捨てる（次に要るときは親の陸の範囲から作り直す）。
   */
  private prune(currentRoots: Set<GroundNode>): void {
    const keep = (node: GroundNode): boolean => {
      let used = node.state === 'loading' || node.state === 'ready';
      if (node.children) {
        let childUsed = false;
        for (const child of node.children) if (child && keep(child)) childUsed = true;
        if (!childUsed) node.children = null;
        used ||= childUsed;
      }
      return used;
    };
    for (const [key, root] of this.roots) {
      if (!keep(root) && !currentRoots.has(root)) this.roots.delete(key);
    }
  }
}

/** 祖先のシーンの霧（線形の Fog）。 */
function findFog(obj: Group): Fog | null {
  for (let o = obj.parent; o; o = o.parent) {
    const fog = (o as { fog?: unknown }).fog;
    if (fog instanceof Fog) return fog;
  }
  return null;
}

/** 地面のタイルのズームに対して取得する標高タイルのズーム。 */
function demZoom(zoom: number): number {
  return zoom <= GSI_DEM10_MAX_ZOOM ? zoom : GSI_DEM5A_ZOOM;
}

/**
 * タイル (z, x, y) を n 等分した格子点（と、外側 margin 点）の標高を、細かい順の標高タイルから引く。
 * 緯度と経度の計算を行・列ごとに 1 回で済ませる。どの標高タイルでも無効なら NaN。
 */
class DemSampler {
  /** 標高タイルごとの、列 i・行 j の画素位置（タイルの外なら NaN）。 */
  private readonly px: Float64Array[];
  private readonly py: Float64Array[];
  /** 直前の at() の値を引いた標高タイルの番号（dems の添字。無効なら −1）。 */
  lastSource = -1;

  constructor(
    private readonly dems: readonly DemTile[],
    z: number,
    x: number,
    y: number,
    n: number,
    private readonly margin: number,
    /** 格子点を画素の中心に置く（画像の画素の標高を引く）なら 0.5。頂点なら 0。 */
    offset = 0,
  ) {
    const count = n + 1 + 2 * margin;
    this.px = dems.map((dem) => {
      const a = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const lon = tileXToLon(x + (i - margin + offset) / n, z);
        const p = (lonToTileX(lon, dem.z) - dem.x) * DEM_SIZE;
        a[i] = p < 0 || p > DEM_SIZE ? Number.NaN : p;
      }
      return a;
    });
    this.py = dems.map((dem) => {
      const a = new Float64Array(count);
      for (let j = 0; j < count; j++) {
        const lat = tileYToLat(y + (j - margin + offset) / n, z);
        const p = (latToTileY(lat, dem.z) - dem.y) * DEM_SIZE;
        a[j] = p < 0 || p > DEM_SIZE ? Number.NaN : p;
      }
      return a;
    });
  }

  /** 列 i・行 j（−margin〜n+margin）の標高。 */
  at(i: number, j: number): number {
    const ii = i + this.margin;
    const jj = j + this.margin;
    for (let k = 0; k < this.dems.length; k++) {
      const px = this.px[k]![ii]!;
      const py = this.py[k]![jj]!;
      if (Number.isNaN(px) || Number.isNaN(py)) continue;
      const h = sampleDem(this.dems[k]!, px, py);
      if (!Number.isNaN(h)) {
        this.lastSource = k;
        return h;
      }
    }
    this.lastSource = -1;
    return Number.NaN;
  }
}

export interface GroundSurface {
  /** TEX×TEX の RGBA（sRGB）。陸は陸の色に陰影を掛けた色で不透明、海（標高の無効値）は透明（opaque のときは不透明）。 */
  pixels: Uint8Array;
}

/**
 * タイル (z, x, y) に貼る画像を、細かい順の標高タイルから作る。各画素の中心の標高を引き、上下左右の画素との差から
 * 傾きを求めて、光（LIGHT）に向く斜面を明るく、背く斜面を暗くする（平らな面は陸の色のまま）。
 * 隣の画素が別の標高タイル（5m メッシュの縁の外で 10m メッシュから引いたなど）の値なら、その差は使わず片側の差で求める
 * （標高タイルの縁に陰影の線が出ないように）。opaque なら、標高の無効値も透明にせず陸の色にする。
 */
export function buildSurface(
  z: number,
  x: number,
  y: number,
  dems: readonly DemTile[],
  size: number = TEX,
  opaque = false,
): GroundSurface {
  const sampler = new DemSampler(dems, z, x, y, size, 1, 0.5);
  const w = size + 2;
  const heights = new Float32Array(w * w);
  const sources = new Int8Array(w * w);
  for (let j = -1; j <= size; j++) {
    for (let i = -1; i <= size; i++) {
      heights[(j + 1) * w + (i + 1)] = sampler.at(i, j);
      sources[(j + 1) * w + (i + 1)] = sampler.lastSource;
    }
  }
  // 画素の間隔(m)。タイルはメルカトルの正方形なので、東西と南北はほぼ同じ
  const a = latLonToLocal({ lat: tileYToLat(y, z), lon: tileXToLon(x, z) });
  const b = latLonToLocal({ lat: tileYToLat(y + 1, z), lon: tileXToLon(x + 1, z) });
  const dx = (b.x - a.x) / size;
  const dz = (b.z - a.z) / size;
  const r0 = (BASE_LAND_COLOR >> 16) & 255;
  const g0 = (BASE_LAND_COLOR >> 8) & 255;
  const b0 = BASE_LAND_COLOR & 255;
  const pixels = new Uint8Array(size * size * 4);
  /** 画素 (i, j) の標高。中心の画素 (ci, cj) と別の標高タイルの値なら NaN。 */
  const h = (i: number, j: number, ci: number, cj: number): number =>
    sources[(j + 1) * w + (i + 1)] === sources[(cj + 1) * w + (ci + 1)] ? (heights[(j + 1) * w + (i + 1)] ?? Number.NaN) : Number.NaN;
  /** 片側が無効なら、もう片側との差で傾きを求める。 */
  const slope = (hm: number, hc: number, hp: number, step: number): number => {
    if (!Number.isNaN(hm) && !Number.isNaN(hp)) return (hp - hm) / (2 * step);
    if (!Number.isNaN(hp)) return (hp - hc) / step;
    if (!Number.isNaN(hm)) return (hc - hm) / step;
    return 0;
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 4;
      const hc = heights[(j + 1) * w + (i + 1)] ?? Number.NaN;
      let shade = 1;
      if (!Number.isNaN(hc)) {
        const sx = slope(h(i - 1, j, i, j), hc, h(i + 1, j, i, j), dx) * RELIEF_EXAGGERATION;
        const sz = slope(h(i, j - 1, i, j), hc, h(i, j + 1, i, j), dz) * RELIEF_EXAGGERATION;
        shade = reliefShade(sx, sz);
      }
      pixels[k] = Math.min(255, Math.round(r0 * shade));
      pixels[k + 1] = Math.min(255, Math.round(g0 * shade));
      pixels[k + 2] = Math.min(255, Math.round(b0 * shade));
      pixels[k + 3] = opaque || !Number.isNaN(hc) ? 255 : 0;
    }
  }
  return { pixels };
}

/**
 * 傾き（東へ 1m 進むと sx m、南へ 1m 進むと sz m 上がる）の面の明るさの倍率。平らな面は 1。
 * 光に向く斜面ほど明るく、背く斜面ほど暗い（1 ± RELIEF_STRENGTH の範囲）。
 */
export function reliefShade(sx: number, sz: number): number {
  const len = Math.hypot(sx, 1, sz);
  const lambert = (-sx * LIGHT.x + LIGHT.y - sz * LIGHT.z) / len;
  const flat = LIGHT.y;
  const t = Math.max(-1, Math.min(1, (lambert - flat) / (1 - flat)));
  return 1 + RELIEF_STRENGTH * t;
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
