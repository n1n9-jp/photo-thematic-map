/**
 * PLATEAU 航空写真（PLATEAU-Ortho の XYZ タイル）を、国土地理院の標高で起伏を付けた地面として貼るレイヤー。
 *
 * - 座標は CLAUDE.md の規約どおり latLonToLocal で置く（Y=標高）。
 * - 四分木でカメラからの距離に応じたズームを選ぶ。子タイルが全部そろうまでは親タイルを表示する。
 * - 子タイルの有無は親タイル画像の透明部分（撮影範囲外・海域）から判断し、存在しないタイルは
 *   要求しない（404 をコンソールに出さない）。標高タイルも同様に、親の標高が無効値だけの範囲は要求しない。
 * - 取得に失敗したタイルは間隔を延ばして再試行し、上限に達したら取得不能（failed）として扱う（`tileFetch.ts`）。
 *   取得不能のタイルは親タイルのまま表示し、読み込み完了（ready）の判定では「済み」とみなす。
 *   標高タイルを取得できないときは、祖先の標高（無ければ 0m）で地面を作る。
 * - メモリ: 保持するタイル数に上限を設け、使っていないタイルの画像・標高の参照・木の枝を解放する。
 *   画像（ImageBitmap）と UV は GPU へ転送した後に CPU 側から解放する。
 */
import {
  Box3,
  BufferAttribute,
  Fog,
  BufferGeometry,
  DoubleSide,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { GSI_DEM10_MAX_ZOOM, GSI_DEM5A_ZOOM } from '../../config';
import { latLonToLocal, localToLatLon } from '../../geo/enu';
import { latToTileY, lonToTileX, tileBounds, tileXToLon, tileYToLat } from '../../geo/tiles';
import type { TileBounds } from '../../geo/tiles';
import { plateauMemoryBudget, releaseAfterUpload } from './budget';
import { GsiElevationSource, fetchImagePixels, hasValidHeights, sampleDemAt } from './elevation';
import type { DemKind, DemTile, FetchPixels } from './elevation';
import { ORTHO_SOURCES, orthoSourceFromUrl, orthoTileUrl } from './orthoSource';
import type { OrthoSource } from './orthoSource';
import { TileFetchPolicy, reportTileFailure } from './tileFetch';
import type { TileFetchPolicyOptions } from './tileFetch';

export interface PlateauGroundOptions {
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** カメラの真下からこの半径(m)の範囲に地面を敷く。既定 6000。 */
  radiusM?: number;
  /** 最も粗いズーム。既定 10。 */
  minZoom?: number;
  /** 最も細かいズーム。既定は航空写真の最大（PLATEAU-Ortho 19、国土地理院 18）。 */
  maxZoom?: number;
  /** 航空写真の出典。既定は URL の `?ortho=gsi` があれば国土地理院、なければ PLATEAU-Ortho（`orthoSource.ts`）。 */
  ortho?: OrthoSource;
  /**
   * 画像 1 画素を画面上で何 px まで引き伸ばしてよいか。大きいほど粗いタイルで済ませる。
   * 既定は端末に合わせて plateauMemoryBudget() から選ぶ（パソコン 1.5・スマートフォン 2）。
   */
  texelScale?: number;
  /**
   * カメラが動いている間（と止まってから数フレーム）は、texelScale をこの倍率にして粗いタイルだけを読む。
   * 場面のあいだの移動で通り過ぎる場所の細かいタイルを読まずに済む。1 で無効。既定 4。
   */
  movingTexelFactor?: number;
  /**
   * 霧（シーンの Fog）が掛かる距離では、霧の濃さに応じて粗いタイルで済ませる（色の差が 1−濃さ に薄まるので、
   * 必要な細かさをその割合で下げる）。下げる割合の下限（この値より薄い色の差は、この値とみなす）。0 で無効。既定 0.25。
   */
  fogMinContrast?: number;
  /**
   * 地面を浅い角度で見るタイルは、奥行きの方向に縮んで見えるので粗いタイルで済ませる。視線と地面の角度を θ として、
   * 必要な細かさを √sinθ 倍に下げる（横方向の細かさとの釣り合い）。下げる倍率の下限。1 で無効。既定 0.25。
   */
  grazingMinFactor?: number;
  /** 同時に読み込むタイル数。既定 12。 */
  concurrency?: number;
  /** 保持するタイル数の上限。既定は端末に合わせて plateauMemoryBudget() から選ぶ（パソコン 240・スマートフォン 120）。 */
  maxTiles?: number;
  /**
   * 最も粗いズームのタイルを要求する範囲（度）。航空写真が無い範囲のタイルは 404 になり、ブラウザがコンソールに
   * エラーを記録するので、半径を広げるときは撮影範囲に限る。既定は制限なし。
   */
  rootBounds?: { west: number; south: number; east: number; north: number };
  /** キャッシュする標高タイル数の上限。既定は plateauMemoryBudget() から選ぶ（96・48）。 */
  elevationMaxTiles?: number;
  /** 航空写真・標高の再試行の方針（回数・間隔）。 */
  fetchPolicy?: TileFetchPolicyOptions;
  /** 航空写真・標高の画像の取得（単体テストで差し替える）。既定は fetchImagePixels。 */
  fetchPixels?: FetchPixels;
}

/**
 * unavailable: 存在しない（撮影範囲外など）。failed: 取得できなかった（再試行の上限に達した）。
 * skipped: 読まずに飛ばした途中の段（画像を持たず、子の有無は読み込み済みの祖先の画像から決める）。
 */
type NodeState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed' | 'skipped';

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
  /**
   * 画像を ALPHA_GRID×ALPHA_GRID に分けた各区画に不透明な画素があるか（行優先）。読み込み後に確定し、解放後も残す。
   * 子孫のタイル（MAX_SKIP_DEPTH 段下まで）が存在するかの判断に使う。
   */
  alphaGrid: Uint8Array | null;
  /** 各区画のすべての画素が不透明（アルファ 255）か。途中の段を飛ばしてよいかの判断に使う。 */
  solidGrid: Uint8Array | null;
  children: (GroundNode | null)[] | null;
  /** 細かい順の標高タイル（自分で取得したもの → 祖先のもの）。 */
  dems: DemTile[];
  lastUsed: number;
}

const SEGMENTS = 16;
/** 画像の不透明な区画を調べる細かさ（一辺の区画数）。2^MAX_SKIP_DEPTH。 */
const ALPHA_GRID = 8;
/** 読み込み済みのタイルから何段下まで、途中の段を読まずに子孫の有無を判断できるか。 */
const MAX_SKIP_DEPTH = 3;
/** カメラがこのフレーム数止まっていれば、細かいタイルを読み始める。 */
const STILL_FRAMES = 3;
/** 1 フレームの回転がこれ(rad)を超えたら「動いている」とみなす。 */
const MOVING_ANGLE_RAD = 0.0005;
const SETTLE_FRAMES = 10;
/** 使っていない木の枝を刈り込む間隔（フレーム）。 */
const PRUNE_INTERVAL = 120;
const IMG = 256;

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
  /** 航空写真の再試行の方針。 */
  readonly orthoPolicy: TileFetchPolicy;

  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  /** カメラの真下からこの半径(m)の範囲に地面を敷く。俯瞰の高さに合わせて変えてよい。 */
  radiusM: number;
  private readonly rootBounds: PlateauGroundOptions['rootBounds'];
  private readonly minZoom: number;
  private readonly maxZoom: number;
  /** 航空写真の出典。 */
  readonly ortho: OrthoSource;
  private readonly texelScale: number;
  private readonly movingTexelFactor: number;
  private readonly fogMinContrast: number;
  private readonly grazingMinFactor: number;
  /** 新しく読むタイルを選ぶときの texelScale（カメラが動いている間は粗い）。表示の選び方には使わない。 */
  private requestScale = 1.5;
  private fog: Fog | null = null;
  private readonly prevPos = new Vector3(Number.NaN, 0, 0);
  private readonly prevQuat = new Quaternion();
  /** カメラが止まってからのフレーム数。 */
  private stillFrames = STILL_FRAMES;
  private readonly concurrency: number;
  private readonly maxTiles: number;
  private readonly fetchPixels: FetchPixels;
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
  /** 取得はできたが復号などに失敗したタイルの数。 */
  private brokenTiles = 0;

  constructor(options: PlateauGroundOptions) {
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.radiusM = options.radiusM ?? 6000;
    this.rootBounds = options.rootBounds;
    this.minZoom = options.minZoom ?? 10;
    this.ortho = options.ortho ?? orthoSourceFromUrl();
    const sourceMaxZoom = ORTHO_SOURCES[this.ortho].maxZoom;
    this.maxZoom = Math.min(options.maxZoom ?? sourceMaxZoom, sourceMaxZoom);
    const budget = plateauMemoryBudget();
    this.texelScale = options.texelScale ?? budget.groundTexelScale;
    this.movingTexelFactor = Math.max(1, options.movingTexelFactor ?? 4);
    this.fogMinContrast = Math.min(Math.max(options.fogMinContrast ?? 0.25, 0), 1);
    this.grazingMinFactor = Math.min(Math.max(options.grazingMinFactor ?? 0.25, 0.01), 1);
    this.requestScale = this.texelScale;
    this.concurrency = options.concurrency ?? 12;
    this.maxTiles = options.maxTiles ?? budget.groundMaxTiles;
    this.orthoPolicy = new TileFetchPolicy('航空写真', options.fetchPolicy);
    this.fetchPixels = options.fetchPixels ?? fetchImagePixels;
    this.elevation = new GsiElevationSource({
      fetchPixels: this.fetchPixels,
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

  /** 表示中・読み込み中のタイルがあれば true。 */
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
    return this.movingTexelFactor > 1 && this.stillFrames < STILL_FRAMES;
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
    this.requestScale = this.cameraSettling ? this.texelScale * this.movingTexelFactor : this.texelScale;
  }

  /** 読み込み済みタイル数。 */
  get tileCount(): number {
    return this.loaded.size;
  }

  /** 読み込み済みのタイル（確認用。E2E が読み込み量を、表示に使っているかどうか別に集計する）。 */
  debugTiles(): { z: number; x: number; y: number; visible: boolean }[] {
    return [...this.loaded].map((n) => ({ z: n.z, x: n.x, y: n.y, visible: n.mesh?.visible ?? false }));
  }

  /** 取得できなかった航空写真のタイル数（復号に失敗したものを含む）。 */
  get failedTileCount(): number {
    return this.orthoPolicy.failedCount + this.brokenTiles;
  }

  /** 取得できなかった標高タイルの数。 */
  get failedElevationTileCount(): number {
    return this.elevation.failedTileCount;
  }

  /** 取得できなかったタイルを、次のフレームから取り直す（配信サーバーに再び接続できたときなど）。 */
  retryFailedTiles(): void {
    this.orthoPolicy.reset();
    this.elevation.policy.reset();
    // 取得できなかった標高タイルは null としてキャッシュしているので、キャッシュごと捨てる
    this.elevation.dispose();
    this.brokenTiles = 0;
    const visit = (node: GroundNode): void => {
      if (node.state === 'failed') node.state = 'idle';
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
      alphaGrid: null,
      solidGrid: null,
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

  /**
   * node より細かいタイルにしたいか。scale は texelScale（表示の選び方）か requestScale（新しく読むタイルの選び方）。
   * 表示はカメラが動いていても止まっていても同じ基準で選ぶので、読み込み済みのタイルは移動中も同じものが表示され、
   * 地面のメッシュ（と標高）は変わらない。
   */
  private wantsSplit(node: GroundNode, scale: number = this.texelScale): boolean {
    if (node.z >= this.maxZoom) return false;
    this.renderer.getSize(this.size);
    const f = this.size.y / 2 / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    const d = Math.max(this.distanceTo(node), 1);
    return (node.sizeM * f * this.grazingFactor(node, d)) / d > IMG * scale * this.fogRelief(d);
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
   * 子のどれかが取得できなかった（failed）ときは、子へ進まずに自分を表示する（その範囲に地面が欠けないように）。
   * 飛ばした段（skipped）は、子が全部そろったときだけここへ来るので、子を選ぶ。
   * カメラが動いている間は、表示の選び方は変えず、新しく読むタイルだけを粗くする（requestScale）。
   */
  private select(node: GroundNode, visible: Set<GroundNode>, wanted: GroundNode[]): void {
    if (!this.inView(node)) return;
    node.lastUsed = this.frame;
    if (node.state === 'unavailable' || node.state === 'failed') return;
    if (node.state === 'skipped') {
      for (const k of this.viewKids(node)) this.select(k, visible, wanted);
      return;
    }
    if (node.state !== 'ready') {
      if (node.state === 'idle') wanted.push(node);
      return;
    }
    if (this.wantsSplit(node)) {
      const kids = this.viewKids(node);
      if (kids.every((k) => this.isComplete(k))) {
        for (const k of kids) this.select(k, visible, wanted);
        return;
      }
      const anyFailed = kids.some((k) => k.state === 'failed');
      if (!anyFailed && (!this.cameraSettling || this.wantsSplit(node, this.requestScale))) {
        for (const k of kids) this.request(k, wanted, 1);
      } else {
        for (const k of kids) k.lastUsed = this.frame;
      }
    }
    visible.add(node);
  }

  private inView(node: GroundNode): boolean {
    return this.inRange(node) && this.frustum.intersectsBox(node.box);
  }

  /** 存在し（撮影範囲外でなく）、範囲と視野に入る子。取得できなかった子（failed）も含む。 */
  private viewKids(node: GroundNode): GroundNode[] {
    return this.childrenOf(node).filter((k): k is GroundNode => k !== null && k.state !== 'unavailable' && this.inView(k));
  }

  /** 表示に使える（読み込み済み、または飛ばした段で、子が全部そろっている）か。取得できなかったタイルは使えない。 */
  private isComplete(node: GroundNode): boolean {
    if (node.state === 'ready') return true;
    if (node.state !== 'skipped') return false;
    return this.viewKids(node).every((k) => this.isComplete(k));
  }

  /**
   * 親の代わりに表示するために、node（読み込み済みの祖先から depth 段下）を用意する。node 自身もさらに細かくしたい
   * （子を読むことになる）なら、node の画像は読まずに飛ばし、子を用意する（途中の段を読まない）。
   * 飛ばせるのは、祖先の画像から子孫の有無が確かに分かる範囲（canSkip）で、カメラが動いている間は飛ばさない。
   * 飛ばした段の子が取得できなかったら、飛ばすのをやめて自分の画像を読む（その範囲に表示できる画像を用意する）。
   */
  private request(node: GroundNode, wanted: GroundNode[], depth: number): void {
    node.lastUsed = this.frame;
    if (node.state === 'idle') {
      if (depth < MAX_SKIP_DEPTH && !this.cameraSettling && this.wantsSplit(node) && this.canSkip(node)) {
        node.state = 'skipped';
        node.children = null;
      } else {
        wanted.push(node);
        return;
      }
    }
    if (node.state !== 'skipped') return;
    const kids = this.viewKids(node);
    if (kids.some((k) => k.state === 'failed')) {
      // 子は残す（読み込み済みの子孫は、自分が読めたあとも使える）
      node.state = 'idle';
      wanted.push(node);
      return;
    }
    // 細かくしなくてよくなった（カメラが離れた）うえ、子をまだ何も持っていなければ、飛ばすのをやめて自分を読む
    if (!this.wantsSplit(node) && !(node.children ?? []).some((k) => k && (k.state === 'ready' || k.state === 'loading' || k.state === 'skipped'))) {
      node.state = 'idle';
      node.children = null;
      wanted.push(node);
      return;
    }
    for (const k of kids) this.request(k, wanted, depth + 1);
  }

  /**
   * node の画像を読まずに飛ばしてよいか。読み込み済みの最も近い祖先の画像で、node の範囲の区画とその周りの区画
   * （祖先の画像の中にあるもの）がすべて不透明なときだけ飛ばす。撮影範囲の端に近い区画は、祖先の段の画像では透明でも
   * 細かい段にはタイルがあることがある（画像の縁のアルファは 0〜255 の中間値を取る）ので、1 段ずつ読んで確かめる。
   */
  private canSkip(node: GroundNode): boolean {
    for (let a: GroundNode | null = node.parent; a; a = a.parent) {
      if (!a.solidGrid) continue;
      return regionSolid(a.solidGrid, node.z - a.z, node.x - (a.x << (node.z - a.z)), node.y - (a.y << (node.z - a.z)));
    }
    return false;
  }

  private childrenOf(node: GroundNode): (GroundNode | null)[] {
    if (!node.children) {
      node.children = CHILD_OFFSETS.map(([dx, dy]) => {
        const x = node.x * 2 + dx;
        const y = node.y * 2 + dy;
        return this.descendantAvailable(node, node.z + 1, x, y) ? this.createNode(node.z + 1, x, y, node) : null;
      });
    }
    return node.children;
  }

  /** タイル (z, x, y)（from の子孫）が存在するか。from から近い順に、画像を読んだ祖先の不透明な区画で判断する。 */
  private descendantAvailable(from: GroundNode, z: number, x: number, y: number): boolean {
    for (let a: GroundNode | null = from; a; a = a.parent) {
      if (!a.alphaGrid) continue;
      const depth = z - a.z;
      return regionAny(a.alphaGrid, depth, x - (a.x << depth), y - (a.y << depth));
    }
    return false;
  }


  private async load(node: GroundNode): Promise<void> {
    node.state = 'loading';
    this.loadingCount++;
    try {
      const [img, ownDem] = await Promise.all([
        this.fetchPixels(orthoTileUrl(this.ortho, node.z, node.x, node.y), undefined, this.orthoPolicy),
        this.loadDem(node),
      ]);
      if (this.disposed) {
        img?.bitmap.close();
        return;
      }
      if (!img) {
        node.state = 'unavailable';
        return;
      }
      node.dems = ownDem ? [ownDem, ...(node.parent?.dems ?? [])] : (node.parent?.dems ?? []);
      node.alphaGrid = alphaGrid(img.pixels, img.bitmap.width, img.bitmap.height, ALPHA_GRID);
      node.solidGrid = solidAlphaGrid(img.pixels, img.bitmap.width, img.bitmap.height, ALPHA_GRID);
      node.mesh = this.buildMesh(node, img.bitmap);
      this.group.add(node.mesh);
      node.state = 'ready';
      this.loaded.add(node);
    } catch (err) {
      // 再試行の上限に達した（TileUnavailableError。報告は tileFetch.ts がまとめて行う）か、画像を復号できなかった
      node.state = 'failed';
      if (!(err instanceof Error && err.name === 'TileUnavailableError')) {
        this.brokenTiles++;
        reportTileFailure('航空写真');
      }
    } finally {
      this.loadingCount--;
    }
  }

  /**
   * このタイルのために新たに取得する標高タイル（ズーム14までは同じズームの 10m メッシュ、それより細かいタイルは
   * ズーム15 の 5m メッシュ）。祖先の標高に有効値が無い範囲は取得しない。
   * 途中の段を飛ばしたときも、読み込み済みの最も近い祖先が自分の標高を持っていれば、その範囲から判断して取得する。
   */
  private async loadDem(node: GroundNode): Promise<DemTile | null> {
    const { z, parent } = node;
    const demZoom = (zoom: number): number => (zoom <= GSI_DEM10_MAX_ZOOM ? zoom : GSI_DEM5A_ZOOM);
    const zt = demZoom(z);
    const kind: DemKind = zt === GSI_DEM5A_ZOOM ? 'dem5a' : 'dem10';
    const tx = node.x >> (z - zt);
    const ty = node.y >> (z - zt);
    if (parent) {
      const ancestorDem = parent.dems[0];
      if (!ancestorDem || ancestorDem.z >= zt) return null;
      // 読み込み済みの最も近い祖先が、自分の標高を取得できていなければ（有効値が無い範囲・取得不能）取得しない
      let loadedAncestor: GroundNode | null = parent;
      while (loadedAncestor && loadedAncestor.state === 'skipped') loadedAncestor = loadedAncestor.parent;
      if (loadedAncestor && ancestorDem.z !== demZoom(loadedAncestor.z)) return null;
      const scale = 2 ** (zt - ancestorDem.z);
      const size = Math.max(1, IMG / scale);
      const ox = Math.floor((tx - ancestorDem.x * scale) * size);
      const oy = Math.floor((ty - ancestorDem.y * scale) * size);
      if (!hasValidHeights(ancestorDem, ox, oy, ox + size, oy + size)) return null;
    }
    return this.elevation.getTile(kind, zt, tx, ty);
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
    // GPU へ転送したら CPU 側の画像は要らない（このテクスチャは 1 枚ずつ別の画像を持つ）
    texture.onUpdate = () => {
      bitmap.close();
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
      const image = material.map?.image as ImageBitmap | undefined;
      material.map?.dispose();
      material.dispose();
      image?.close();
    }
    node.mesh = null;
    node.state = 'idle';
    // 標高タイルの参照を手放す（再び読むときに親の標高から作り直す）
    node.dems = [];
  }

  /**
   * 使っていない木の枝を刈り込む。読み込み済み・読み込み中のタイルを含まない枝は、
   * 子の配列ごと捨てる（次に要るときは親の画像の情報から作り直す）。
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

/**
 * ALPHA_GRID×ALPHA_GRID の区画のうち、depth 段下（1〜MAX_SKIP_DEPTH）のタイル (rx, ry)（祖先のタイルの中での位置）の
 * 範囲の区画に 1 があるか。深さが範囲外なら false。
 */
export function regionAny(grid: Uint8Array, depth: number, rx: number, ry: number): boolean {
  if (depth < 1 || depth > MAX_SKIP_DEPTH) return false;
  const cells = ALPHA_GRID >> depth;
  for (let j = ry * cells; j < (ry + 1) * cells; j++) {
    for (let i = rx * cells; i < (rx + 1) * cells; i++) if (grid[j * ALPHA_GRID + i]) return true;
  }
  return false;
}

/**
 * ALPHA_GRID×ALPHA_GRID の区画のうち、depth 段下のタイル (rx, ry)（祖先のタイルの中での位置）の範囲の区画と、
 * その周り 1 区画（格子の中にあるもの）がすべて 1 か。depth は 1〜MAX_SKIP_DEPTH−1（子を祖先の区画で判断できる深さ）。
 */
export function regionSolid(grid: Uint8Array, depth: number, rx: number, ry: number): boolean {
  if (depth < 1 || depth >= MAX_SKIP_DEPTH) return false;
  const cells = ALPHA_GRID >> depth;
  const j0 = Math.max(0, ry * cells - 1);
  const j1 = Math.min(ALPHA_GRID - 1, (ry + 1) * cells);
  const i0 = Math.max(0, rx * cells - 1);
  const i1 = Math.min(ALPHA_GRID - 1, (rx + 1) * cells);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!grid[j * ALPHA_GRID + i]) return false;
  return true;
}

/** RGBA 画素を n×n に分けた各区画（行優先）のすべての画素が不透明（アルファ 255）か（1 / 0）。 */
export function solidAlphaGrid(pixels: ArrayLike<number>, width: number, height: number, n: number): Uint8Array {
  const out = new Uint8Array(n * n).fill(1);
  for (let y = 0; y < height; y++) {
    const row = Math.min(n - 1, Math.floor((y * n) / height));
    for (let x = 0; x < width; x++) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) < 255) out[row * n + Math.min(n - 1, Math.floor((x * n) / width))] = 0;
    }
  }
  return out;
}

/** RGBA 画素を n×n に分けた各区画（行優先）に不透明な画素があるか（1 / 0）。 */
export function alphaGrid(pixels: ArrayLike<number>, width: number, height: number, n: number): Uint8Array {
  const out = new Uint8Array(n * n);
  for (let y = 0; y < height; y++) {
    const row = Math.min(n - 1, Math.floor((y * n) / height));
    for (let x = 0; x < width; x++) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) > 0) out[row * n + Math.min(n - 1, Math.floor((x * n) / width))] = 1;
    }
  }
  return out;
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
