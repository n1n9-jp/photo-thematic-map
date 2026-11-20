/**
 * PLATEAU 建物 3D Tiles をローカル座標（X=東, Y=上, Z=南, 1単位=1m, 原点 ORIGIN）に置くレイヤー。
 *
 * 高さの扱い:
 * - タイルのジオメトリは ECEF・楕円体高。ローカル Y は標高なので GEOID_HEIGHT_M だけ下げる。
 * - ローカル座標は `enu.ts` の局所近似（地球の丸みを持たない平面）。ECEF を剛体変換しただけでは
 *   原点から離れるほど地面が丸みで下がる（6km で約 3m）。そこでタイルごとに、タイル中心の
 *   緯度経度・高さを latLonToLocal で写した点へ、その地点の東・上・南を X・Y・Z に合わせて置き直す。
 *   航空写真の地面も latLonToLocal で置いているので、どこでも建物の足元と地面が一致する。
 */
import { Box3, Group, Matrix4, MeshLambertMaterial, Vector3 } from 'three';
import type { Camera, Material, Mesh, MeshStandardMaterial, Object3D, WebGLRenderer } from 'three';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';
import { GEOID_HEIGHT_M, ORIGIN } from '../../config';
import { ecefToGeodetic, enuBasis, geodeticToEcef } from '../../geo/ecef';
import type { Ecef } from '../../geo/ecef';
import { latLonToLocal } from '../../geo/enu';

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

/**
 * ECEF → ローカル座標の剛体変換。ECEF の点 center がローカルの latLonToLocal(center) に写り、
 * center での東・上・南がローカルの +X・+Y・+Z を向く。
 */
export function ecefToLocalMatrix(center: Ecef, target = new Matrix4()): Matrix4 {
  const g = ecefToGeodetic(center);
  const l = latLonToLocal({ lat: g.lat, lon: g.lon, alt: g.height - GEOID_HEIGHT_M });
  const { east: e, north: n, up: u } = enuBasis(g.lat, g.lon);
  const dot = (a: Ecef): number => a.x * center.x + a.y * center.y + a.z * center.z;
  // prettier-ignore
  return target.set(
    e.x, e.y, e.z, l.x - dot(e),
    u.x, u.y, u.z, l.y - dot(u),
    -n.x, -n.y, -n.z, l.z + dot(n),
    0, 0, 0, 1,
  );
}

function createDracoLoader(): DRACOLoader {
  // three 同梱の glTF 用デコーダー（Vite がビルドに含める）を使う
  const loader = new DRACOLoader();
  loader.setDecoderPath(DRACO_GLTF_CONFIG);
  return loader;
}

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
    scene.matrix.premultiply(this.local).premultiply(this.groupInverse);
    scene.matrix.decompose(scene.position, scene.quaternion, scene.scale);
    scene.updateMatrixWorld(true);
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      // タイルのマテリアル（とテクスチャ）は使わず、共有の白に置き換える
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (m as MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
      mesh.material = this.material;
    });
  }
}

/** カメラから遠いタイルを読まない・描かないプラグイン（3d-tiles-renderer の calculateTileViewError フック）。 */
class DistanceLimitPlugin {
  readonly name = 'PTM_DISTANCE_LIMIT';
  /** タイルセットの座標系（group の行列の逆）でのカメラの位置。update の前に設定する。 */
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
  /** 初回のタイル読み込みが終わると解決する。 */
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

    // 原点（標高 ORIGIN.alt の地点）での ECEF → ローカルの剛体変換。カリング・LOD 判定に使われる。
    const originEcef = geodeticToEcef(ORIGIN.lat, ORIGIN.lon, ORIGIN.alt + GEOID_HEIGHT_M);
    const groupMatrix = ecefToLocalMatrix(originEcef);

    for (const url of options.urls) {
      const tiles = new TilesRenderer(url);
      tiles.errorTarget = options.errorTarget ?? 16;
      // 親タイルは大きな建物だけを含み、子で置き換わる（REPLACE）。表示に要る細かさのタイルだけを読む。
      tiles.loadAncestors = false;
      tiles.loadSiblings = false;
      tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco, autoDispose: false }));
      tiles.registerPlugin(new LocalFramePlugin(groupMatrix, this.material));
      if (this.maxDistanceM) {
        const plugin = new DistanceLimitPlugin();
        this.distancePlugins.push(plugin);
        tiles.registerPlugin(plugin);
      }
      tiles.group.matrixAutoUpdate = false;
      tiles.group.matrix.copy(groupMatrix);
      tiles.group.matrixWorldNeedsUpdate = true;
      tiles.setCamera(this.camera);
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
    if (this.maxDistanceM && this.tiles[0]) {
      const max = this.maxDistanceM();
      this.groupInverse.copy(this.tiles[0].group.matrixWorld).invert();
      for (const p of this.distancePlugins) {
        p.maxDistance = max;
        p.cameraLocal.setFromMatrixPosition(this.camera.matrixWorld).applyMatrix4(this.groupInverse);
      }
    }
    for (const tiles of this.tiles) {
      tiles.setResolutionFromRenderer(this.camera, this.renderer);
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

  dispose(): void {
    for (const tiles of this.tiles) tiles.dispose();
    this.tiles.length = 0;
    if (this.ownsDraco) this.draco.dispose();
    this.group.removeFromParent();
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    this.resolveReady();
  }
}
