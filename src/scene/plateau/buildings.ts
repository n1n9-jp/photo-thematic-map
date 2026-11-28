/**
 * PLATEAU 建物 3D Tiles をローカル座標（X=東, Y=上, Z=南, 1単位=1m, 原点 ORIGIN）に置くレイヤー。
 *
 * 高さと位置の扱い:
 * - タイルのジオメトリは ECEF・楕円体高。ローカル Y は標高なので GEOID_HEIGHT_M だけ下げる。
 * - ローカル座標は `enu.ts` の局所近似（地球の丸みを持たない平らな地図）。ECEF を剛体変換しただけでは
 *   原点から離れるほど地面が丸みで下がる（6km で約 3m）。そこでタイルごとに、タイル中心の
 *   緯度経度・高さを latLonToLocal で写した点へ、その地点の東・上・南を X・Y・Z に合わせて置き直す。
 *   さらに東西・南北の縮尺を、その地点での latLonToLocal の縮尺に合わせる（アフィン変換）ので、
 *   タイル内のずれは 2 次の大きさ（タイル中心から 225m で 1cm 程度）に収まる。
 *   地面も latLonToLocal で置いているので、どこでも建物の足元と地面が一致する。
 * - 3d-tiles-renderer のカリングと詳細度の判定は、原点の剛体変換（tiles.group.matrix）の座標で行われる。
 *   原点から離れた場所では、表示の位置と判定の位置がずれる（高さ方向に 11.5km で約 10m、
 *   水平にも数 m）。そこで判定には、カメラの位置で平らな地図 → 判定の座標へ写したカメラ（cullCamera）を渡す。
 *
 * 見た目:
 * - 写真テクスチャは使わない（lod2_no_texture を読む）。タイルのマテリアルは共有の白（面の向きで陰影）に置き換える。
 *
 * 失敗とメモリ:
 * - タイルの取得は `tileFetch.ts` の方針で再試行し、取得できなかったタイルは空のタイルとして扱う
 *   （読み込み完了の判定を止めず、ライブラリにタイルごとのエラーを出させない）。
 * - LRU キャッシュは層（このクラスの 1 インスタンス）ごとに持ち、上限は `budget.ts` で端末に合わせて選ぶ。
 * - 頂点の位置・索引・_batchid 以外は GPU へ転送した後に解放する。
 */
import { Box3, Group, Matrix4, MeshLambertMaterial, PerspectiveCamera, Vector3 } from 'three';
import type { BufferAttribute, Camera, Material, Mesh, MeshStandardMaterial, Object3D, WebGLRenderer } from 'three';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { DEFAULT_LRU_CACHE, LRUCache } from '3d-tiles-renderer/core';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';
import { GEOID_HEIGHT_M, ORIGIN } from '../../config';
import { curvatureRadii, ecefToGeodetic, enuBasis, geodeticToEcef } from '../../geo/ecef';
import type { Ecef } from '../../geo/ecef';
import { latLonToLocal, localMetersPerDegree, localToLatLon } from '../../geo/enu';
import { plateauMemoryBudget, releaseAfterUpload } from './budget';
import type { BuildingCacheBudget } from './budget';
import { TileFetchPolicy, reportTileFailure } from './tileFetch';
import type { TileFetchPolicyOptions } from './tileFetch';

export interface PlateauBuildingsOptions {
  /** tileset.json の URL の配列。 */
  urls: readonly string[];
  camera: Camera;
  renderer: WebGLRenderer;
  /** 画面上の許容誤差(px)。小さいほど細かいタイルまで読む。既定 16。 */
  errorTarget?: number;
  /**
   * 建物に貼るマテリアル。タイルのマテリアル（テクスチャを含む）は捨ててこれに置き換える。
   * 既定は `whiteBuildingMaterial()`（面の向きで陰影の付く白）。
   */
  material?: Material;
  /**
   * カメラからこの距離(m)より遠いタイルは読まず、描かない（霧で見えなくなる距離に合わせる）。毎フレーム呼ぶ。
   * 既定は制限なし。区の範囲の矩形は広いことがあり、地平線の近くの粗いタイル（1つ数MB〜10MB）を読んでしまうため。
   */
  maxDistanceM?: () => number;
  /** Draco のデコーダー。複数の層で共有するときに渡す（渡したものは dispose しない）。既定は層ごとに作る。 */
  dracoLoader?: DRACOLoader;
  /**
   * この層の LRU キャッシュの上限。既定は plateauMemoryBudget()。
   * 上限に達すると新しいタイルを読まないので、表示に要るタイルが収まる大きさにする。
   */
  cache?: Partial<BuildingCacheBudget>;
  /**
   * 複数の層で共有する LRU キャッシュ（区ごとに層を分けるときに、上限を層の数だけ増やさないため）。
   * 渡したときは `cache` を使わず、上限は渡す側で設定する。
   */
  lruCache?: LRUCache;
  /** タイル取得の再試行の方針（回数・間隔）。 */
  fetchPolicy?: TileFetchPolicyOptions;
}

let sharedWhite: MeshLambertMaterial | null = null;

/**
 * 白い建物のマテリアル（全層で共有）。面ごとの法線（flatShading）で陰影を付けるので、タイルに法線が無くても
 * 屋上と壁、壁どうしの向きの違いが明暗で読み取れる。真っ白に飛ばないよう、色は少しだけ灰色に寄せる。
 */
export function whiteBuildingMaterial(): MeshLambertMaterial {
  sharedWhite ??= new MeshLambertMaterial({ color: 0xe9e7e2, flatShading: true });
  return sharedWhite;
}

/** 連続でこのフレーム数だけ読み込み待ちがなければ「読み込み完了」とみなす。 */
const SETTLE_FRAMES = 10;
const DEG2RAD = Math.PI / 180;

/**
 * ECEF → ローカル座標の変換。ECEF の点 center がローカルの latLonToLocal(center) に写り、
 * center での東・上・南がローカルの +X・+Y・+Z を向く。
 *
 * scale が true（既定）なら、東西・南北の縮尺を center での latLonToLocal の縮尺（緯度経度あたりの m）に
 * 合わせる。latLonToLocal は原点の曲率半径で緯度経度を m にするので、center の実寸（曲率半径＋楕円体高）とは
 * 縮尺が違う（赤羽で東西 0.12%）。剛体変換のままだと、タイル中心から離れるほど地面とずれる。
 * scale が false なら剛体変換（長さを保つ）。
 */
export function ecefToLocalMatrix(center: Ecef, target = new Matrix4(), scale = true): Matrix4 {
  const g = ecefToGeodetic(center);
  const l = latLonToLocal({ lat: g.lat, lon: g.lon, alt: g.height - GEOID_HEIGHT_M });
  const { east: e, north: n, up: u } = enuBasis(g.lat, g.lon);
  let sx = 1;
  let sz = 1;
  if (scale) {
    // 実寸: 経度 1 度 = (N + h) cosφ・π/180、緯度 1 度 = (M + h)・π/180
    const { m, n: nr } = curvatureRadii(g.lat);
    const flat = localMetersPerDegree();
    sx = flat.east / (DEG2RAD * (nr + g.height) * Math.cos(g.lat * DEG2RAD));
    sz = flat.north / (DEG2RAD * (m + g.height));
  }
  const dot = (a: Ecef): number => a.x * center.x + a.y * center.y + a.z * center.z;
  // prettier-ignore
  return target.set(
    sx * e.x, sx * e.y, sx * e.z, l.x - sx * dot(e),
    u.x, u.y, u.z, l.y - dot(u),
    -sz * n.x, -sz * n.y, -sz * n.z, l.z + sz * dot(n),
    0, 0, 0, 1,
  );
}

/**
 * 地点 at（ローカル座標）の近くで、平らな地図の座標を 3d-tiles-renderer の判定の座標
 * （ECEF に groupMatrix＝原点の剛体変換を掛けた座標）へ写す行列。
 * at での「ECEF → 平らな地図」（ecefToLocalMatrix）の逆で ECEF に戻してから groupMatrix を掛ける。
 */
export function localToCullFrameMatrix(at: Vector3, groupMatrix: Matrix4, target = new Matrix4()): Matrix4 {
  const g = localToLatLon(at);
  const ecef = geodeticToEcef(g.lat, g.lon, g.alt + GEOID_HEIGHT_M);
  return ecefToLocalMatrix(ecef, target).invert().premultiply(groupMatrix);
}

/** 原点での ECEF → ローカルの剛体変換（3d-tiles-renderer の tiles.group.matrix）。 */
export function originGroupMatrix(target = new Matrix4()): Matrix4 {
  const originEcef = geodeticToEcef(ORIGIN.lat, ORIGIN.lon, ORIGIN.alt + GEOID_HEIGHT_M);
  return ecefToLocalMatrix(originEcef, target, false);
}

function createDracoLoader(): DRACOLoader {
  // three 同梱の glTF 用デコーダー（Vite がビルドに含める）を使う
  const loader = new DRACOLoader();
  loader.setDecoderPath(DRACO_GLTF_CONFIG);
  return loader;
}

/** GPU へ転送した後も CPU 側に残す頂点属性（レイキャストと地物の判定に使う）。 */
const KEEP_ATTRIBUTES = new Set(['position', '_batchid']);

/** タイル中心で ECEF→ローカルの置き直しを行うプラグイン。group の剛体変換との差分だけを掛ける。 */
class LocalFramePlugin {
  readonly name = 'PTM_LOCAL_FRAME';
  private readonly groupInverse: Matrix4;
  private readonly box = new Box3();
  private readonly center = new Vector3();
  private readonly local = new Matrix4();

  constructor(
    groupMatrix: Matrix4,
    private readonly material: Material,
  ) {
    this.groupInverse = groupMatrix.clone().invert();
  }

  processTileModel(scene: Object3D): void {
    // この時点の scene.matrix はタイル座標 → ECEF（親を持たない）
    scene.updateMatrixWorld(true);
    this.box.setFromObject(scene);
    if (this.box.isEmpty()) return;
    this.box.getCenter(this.center);
    ecefToLocalMatrix(this.center, this.local);
    // 縮尺を含む（せん断を含みうる）行列なので、位置・回転・拡大に分解せずに行列のまま持つ
    scene.matrix.premultiply(this.local).premultiply(this.groupInverse);
    scene.matrixAutoUpdate = false;
    scene.updateMatrixWorld(true);
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      // タイルのマテリアル（とテクスチャ）は使わず、共有の白に置き換える。屋上の設備（BuildingInstallation）の
      // 金属のマテリアルも置き換わるので、環境マップのない場面で暗くなることもない
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (m as MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
      mesh.material = this.material;
      for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        if (!KEEP_ATTRIBUTES.has(name)) releaseAfterUpload(attribute as BufferAttribute);
      }
    });
  }
}

/** 建物の LRU キャッシュを、端末に合わせた上限（plateauMemoryBudget）で作る。 */
export function createBuildingLruCache(overrides: Partial<BuildingCacheBudget> = {}): LRUCache {
  const cache = { ...plateauMemoryBudget().buildingCache, ...overrides };
  const lru = new LRUCache();
  lru.unloadPriorityCallback = DEFAULT_LRU_CACHE.unloadPriorityCallback;
  lru.minBytesSize = cache.minBytes;
  lru.maxBytesSize = Math.max(cache.maxBytes, cache.minBytes);
  lru.minSize = cache.minTiles;
  lru.maxSize = Math.max(cache.maxTiles, cache.minTiles);
  return lru;
}

/** 取得できなかったタイルの代わりに返す中身（parseTile で空のタイルにする）。 */
const FAILED_CONTENT = Object.freeze({ ptmFailedTile: true });

/** 取得できなかったルートの tileset.json の代わり（タイルを持たない tileset）。 */
function emptyTileset(): object {
  return {
    asset: { version: '1.0' },
    geometricError: 0,
    root: { boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: 0, refine: 'REPLACE', children: [] },
  };
}

/**
 * タイルの取得を TileFetchPolicy で行うプラグイン（fetchData・parseTile フック）。
 * 取得できなかったタイルは空のタイルとして読み込み済みにする。ライブラリは失敗したタイルごとに
 * console.error を 2 件出し、LRU から外れると要求し直すので、それを避ける。
 */
class TileFetchPlugin {
  readonly name = 'PTM_TILE_FETCH';
  /** 存在しなかった（404 など）タイルの数。 */
  missingCount = 0;
  private tiles: { rootURL: string | null } | null = null;

  constructor(readonly policy: TileFetchPolicy) {}

  init(tiles: { rootURL: string | null }): void {
    this.tiles = tiles;
  }

  async fetchData(url: string, options: RequestInit): Promise<Response | object> {
    try {
      const res = await this.policy.fetch(url, options);
      if (res) return res;
      this.missingCount++;
      reportTileFailure('建物');
    } catch (err) {
      if (!(err instanceof Error && err.name === 'TileUnavailableError')) throw err;
    }
    return url === this.tiles?.rootURL ? emptyTileset() : FAILED_CONTENT;
  }

  parseTile(content: unknown): Promise<void> | undefined {
    return content === FAILED_CONTENT ? Promise.resolve() : undefined;
  }
}


/** カメラから遠いタイルを読まない・描かないプラグイン（3d-tiles-renderer の calculateTileViewError フック）。 */
class DistanceLimitPlugin {
  readonly name = 'PTM_DISTANCE_LIMIT';
  /** タイルセットの座標系（tiles.group の行列の逆）での判定用カメラの位置。update の前に設定する。 */
  readonly cameraLocal = new Vector3();
  maxDistance = Infinity;

  calculateTileViewError(
    tile: { engineData?: { boundingVolume?: { distanceToPoint(p: Vector3): number } } },
    target: { inView: boolean },
  ): boolean {
    const bv = tile.engineData?.boundingVolume;
    if (!bv || !Number.isFinite(this.maxDistance)) return false;
    if (bv.distanceToPoint(this.cameraLocal) <= this.maxDistance) return false;
    target.inView = false;
    return true;
  }
}

export class PlateauBuildings {
  /** シーンに追加するグループ。 */
  readonly group = new Group();
  /** 初回のタイル読み込みが終わると解決する（取得できなかったタイルがあっても解決する）。 */
  readonly ready: Promise<void>;
  /** 初回のタイル読み込みが終わっていれば true。 */
  isReady = false;

  private readonly tiles: TilesRenderer[] = [];
  /** ルート tileset の読み込みが済んでいない（失敗は済みとみなす）renderer。 */
  private readonly rootPending = new Set<TilesRenderer>();
  /** タイルを読み込み中の renderer。 */
  private readonly loading = new Set<TilesRenderer>();
  private readonly camera: Camera;
  private readonly renderer: WebGLRenderer;
  private readonly draco: DRACOLoader;
  private readonly ownsDraco: boolean;
  private readonly material: Material;
  private readonly maxDistanceM: (() => number) | undefined;
  private readonly distancePlugins: DistanceLimitPlugin[] = [];
  private readonly groupInverse = new Matrix4();
  /** この層の tileset が共有する LRU キャッシュ。 */
  private readonly lruCache: LRUCache;
  private readonly fetchPlugins: TileFetchPlugin[] = [];
  /** 取得の再試行の方針（この層の tileset で共有）。 */
  readonly fetchPolicy: TileFetchPolicy;
  /** 原点での ECEF → ローカルの剛体変換（ライブラリのカリング・詳細度の判定の座標）。 */
  private readonly groupMatrix: Matrix4;
  /** カリング・詳細度の判定に渡すカメラ。 */
  private readonly cullCamera = new PerspectiveCamera();
  private readonly camLocal = new Vector3();
  /** カメラの位置での「平らな地図 → 判定の座標」。 */
  private readonly camFrame = new Matrix4();
  private resolveReady!: () => void;
  private settledFrames = 0;

  constructor(options: PlateauBuildingsOptions) {
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.ownsDraco = !options.dracoLoader;
    this.draco = options.dracoLoader ?? createDracoLoader();
    this.material = options.material ?? whiteBuildingMaterial();
    this.maxDistanceM = options.maxDistanceM;
    this.group.name = 'plateau-buildings';
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.lruCache = options.lruCache ?? createBuildingLruCache(options.cache);
    this.fetchPolicy = new TileFetchPolicy('建物', options.fetchPolicy);

    // 原点（標高 ORIGIN.alt の地点）での ECEF → ローカルの剛体変換。カリング・LOD 判定に使われる。
    this.groupMatrix = originGroupMatrix();
    this.cullCamera.matrixAutoUpdate = false;
    this.cullCamera.matrixWorldAutoUpdate = false;

    for (const url of options.urls) {
      const tiles = new TilesRenderer(url);
      tiles.errorTarget = options.errorTarget ?? 16;
      tiles.lruCache = this.lruCache;
      // 親タイルは大きな建物だけを含み、子で置き換わる（REPLACE）。表示に要る細かさのタイルだけを読む。
      tiles.loadAncestors = false;
      tiles.loadSiblings = false;
      const fetchPlugin = new TileFetchPlugin(this.fetchPolicy);
      this.fetchPlugins.push(fetchPlugin);
      tiles.registerPlugin(fetchPlugin);
      tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco, autoDispose: false }));
      tiles.registerPlugin(new LocalFramePlugin(this.groupMatrix, this.material));
      if (this.maxDistanceM) {
        const plugin = new DistanceLimitPlugin();
        this.distancePlugins.push(plugin);
        tiles.registerPlugin(plugin);
      }
      tiles.group.matrixAutoUpdate = false;
      tiles.group.matrix.copy(this.groupMatrix);
      tiles.group.matrixWorldNeedsUpdate = true;
      tiles.setCamera(this.cullCamera);
      this.rootPending.add(tiles);
      tiles.addEventListener('load-root-tileset', () => this.rootPending.delete(tiles));
      tiles.addEventListener('load-error', (e) => {
        if (e.tile === null) this.rootPending.delete(tiles);
      });
      tiles.addEventListener('tiles-load-start', () => this.loading.add(tiles));
      tiles.addEventListener('tiles-load-end', () => this.loading.delete(tiles));
      this.group.add(tiles.group);
      this.tiles.push(tiles);
    }
    if (this.tiles.length === 0) this.markReady();
  }

  /** 毎フレーム、描画の前に呼ぶ。 */
  update(): void {
    this.camera.updateMatrixWorld();
    this.group.updateMatrixWorld();
    this.updateCullCamera();
    if (this.maxDistanceM && this.tiles[0]) {
      // 判定はライブラリの座標（tiles.group）で行われるので、判定用カメラの位置をその座標へ写す
      const max = this.maxDistanceM();
      this.groupInverse.copy(this.tiles[0].group.matrixWorld).invert();
      for (const p of this.distancePlugins) {
        p.maxDistance = max;
        p.cameraLocal.setFromMatrixPosition(this.cullCamera.matrixWorld).applyMatrix4(this.groupInverse);
      }
    }
    for (const tiles of this.tiles) {
      tiles.setResolutionFromRenderer(this.cullCamera, this.renderer);
      tiles.update();
    }
    if (this.isReady) return;
    const busy = this.isLoading || this.tiles.some((t) => t.loadProgress < 1);
    this.settledFrames = busy ? 0 : this.settledFrames + 1;
    if (this.settledFrames >= SETTLE_FRAMES) this.markReady();
  }

  /** 読み込み中のタイルがあれば true。 */
  get isLoading(): boolean {
    return this.rootPending.size > 0 || this.loading.size > 0;
  }

  /** 取得できなかったタイル（tileset.json を含む）の数。 */
  get failedTileCount(): number {
    return this.fetchPolicy.failedCount + this.fetchPlugins.reduce((sum, p) => sum + p.missingCount, 0);
  }

  /** LRU キャッシュにあるタイルの数と、その推定バイト数。 */
  get cacheStats(): { tiles: number; bytes: number } {
    const bytes = (this.lruCache as unknown as { cachedBytes: number }).cachedBytes;
    return { tiles: this.tiles.reduce((sum, t) => sum + (t as unknown as { stats: { inCache: number } }).stats.inCache, 0), bytes };
  }

  /** 表示中のタイルの数。 */
  get visibleTileCount(): number {
    return this.tiles.reduce((sum, t) => sum + t.visibleTiles.size, 0);
  }

  /**
   * 取得できなかったタイルを取り直す（配信サーバーに再び接続できたときなど）。
   * 空のタイルとして読み込み済みにしたものは LRU から外して、次のフレームから要求し直す。
   */
  retryFailedTiles(): void {
    this.fetchPolicy.reset();
    for (const p of this.fetchPlugins) p.missingCount = 0;
    for (const tiles of this.tiles) {
      tiles.resetFailedTiles();
      const traverse = tiles.traverse.bind(tiles) as unknown as (
        before: (tile: object) => boolean,
        after: null,
        ensureFullyProcessed: boolean,
      ) => void;
      traverse(
        (tile) => {
          const t = tile as { content?: { uri?: string }; engineData?: { scene?: unknown } };
          if (t.content?.uri !== undefined && !t.engineData?.scene && this.lruCache.has(tile)) this.lruCache.remove(tile);
          return false;
        },
        null,
        false,
      );
    }
  }

  dispose(): void {
    for (const tiles of this.tiles) tiles.dispose();
    this.tiles.length = 0;
    if (this.ownsDraco) this.draco.dispose();
    this.group.removeFromParent();
  }

  /**
   * ライブラリの判定用のカメラを更新する。カメラの位置では、平らな地図の座標と判定の座標（原点の剛体変換）が
   * 一致するように、カメラの位置での「平らな地図 → ECEF」を挟んで写す。
   */
  private updateCullCamera(): void {
    const cam = this.camera;
    const cull = this.cullCamera;
    this.camLocal.setFromMatrixPosition(cam.matrixWorld);
    localToCullFrameMatrix(this.camLocal, this.groupMatrix, this.camFrame);
    cull.matrixWorld.multiplyMatrices(this.camFrame, cam.matrixWorld);
    cull.matrixWorldInverse.copy(cull.matrixWorld).invert();
    cull.projectionMatrix.copy(cam.projectionMatrix);
    cull.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    cull.coordinateSystem = cam.coordinateSystem;
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    this.resolveReady();
  }
}
