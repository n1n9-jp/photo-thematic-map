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
import { Box3, Group, Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import type { Camera, Material, Mesh, MeshStandardMaterial, Object3D, Texture, WebGLRenderer } from 'three';
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
   * 表示する範囲を、ローカル座標の鉛直な円柱の内側か外側に限る。
   * - inside: 円に掛かるタイルだけを読み、カメラの位置によらず最も細かいタイルまで読む。円の外の部分は描かない。
   * - outside: 円にすっぽり入るタイルは読まない。円の内の部分は描かない。
   * 同じ円で inside（テクスチャ付き）と outside（テクスチャなし）の 2 層を重ねると、境界で建物が二重にならない。
   */
  area?: { x: number; z: number; radiusM: number; side: 'inside' | 'outside' };
  /**
   * テクスチャの長辺の上限(px)。PLATEAU のテクスチャは 1 タイルで最大 4096px 四方あり、そのままでは
   * GPU メモリを使い切るので、読み込み時に縮小する。既定 1024。
   */
  maxTextureSize?: number;
}

export type BuildingArea = NonNullable<PlateauBuildingsOptions['area']>;

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
    private readonly area: BuildingArea | undefined,
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
    const area = this.area;
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      // 写真テクスチャは撮影時の陰影を含むので、地面の航空写真と同じく照明を当てずに貼る
      const mat = mesh.material as MeshStandardMaterial;
      if (!Array.isArray(mesh.material) && mat.map) {
        const basic = new MeshBasicMaterial({ map: mat.map, side: mat.side, vertexColors: mat.vertexColors });
        basic.name = mat.name;
        mat.dispose();
        mesh.material = basic;
      }
      if (area) {
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) clipMaterialToArea(m, area);
      }
    });
  }
}

interface TileLike {
  boundingVolume?: { region?: number[] };
  geometricError?: number;
  children?: unknown[];
}

/** タイルの範囲（region）をローカル XZ の矩形にする。region でなければ null。 */
function tileRect(tile: TileLike): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  const r = tile.boundingVolume?.region;
  if (!r || r.length < 4) return null;
  const [w, s, e, n] = r.map((v) => (v * 180) / Math.PI) as [number, number, number, number];
  const a = latLonToLocal({ lat: n, lon: w });
  const b = latLonToLocal({ lat: s, lon: e });
  return { minX: a.x, maxX: b.x, minZ: a.z, maxZ: b.z };
}

/** 円柱で読み込むタイルを絞るプラグイン（3d-tiles-renderer の calculateTileViewError フック）。 */
class AreaPlugin {
  readonly name = 'PTM_AREA';
  private readonly cache = new WeakMap<object, { intersects: boolean; contained: boolean }>();

  constructor(private readonly area: BuildingArea) {}

  calculateTileViewError(tile: TileLike, target: { inView: boolean; error: number; distance: number }): boolean {
    let hit = this.cache.get(tile);
    if (!hit) {
      const rect = tileRect(tile);
      const { x, z, radiusM } = this.area;
      if (rect) {
        const nx = Math.max(rect.minX - x, 0, x - rect.maxX);
        const nz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
        const fx = Math.max(Math.abs(rect.minX - x), Math.abs(rect.maxX - x));
        const fz = Math.max(Math.abs(rect.minZ - z), Math.abs(rect.maxZ - z));
        hit = { intersects: Math.hypot(nx, nz) <= radiusM, contained: Math.hypot(fx, fz) <= radiusM };
      } else {
        hit = { intersects: true, contained: false };
      }
      this.cache.set(tile, hit);
    }
    if (this.area.side === 'inside') {
      target.inView = hit.intersects;
      // 円の中は常に最も細かいタイルまで読む
      target.error = tile.children && tile.children.length > 0 ? Number.MAX_VALUE : 0;
      target.distance = 0;
      return true;
    }
    if (hit.contained) {
      target.inView = false;
      return true;
    }
    return false;
  }
}

/** 円柱の内側または外側だけを描くようにマテリアルのシェーダーを書き換える。 */
function clipMaterialToArea(material: Material, area: BuildingArea): void {
  const sign = area.side === 'inside' ? 1 : -1;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.ptmArea = { value: new Vector3(area.x, area.z, area.radiusM) };
    shader.uniforms.ptmAreaSign = { value: sign };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPtmWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvPtmWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPtmWorld;\nuniform vec3 ptmArea;\nuniform float ptmAreaSign;')
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif (ptmAreaSign * (length(vPtmWorld.xz - ptmArea.xy) - ptmArea.z) > 0.0) discard;',
      );
  };
  material.customProgramCacheKey = () => `ptm-area-${sign}`;
  material.needsUpdate = true;
}

/** 大きすぎるテクスチャを読み込み時に縮小するプラグイン。 */
class TextureDownscalePlugin {
  readonly name = 'PTM_TEXTURE_DOWNSCALE';

  constructor(private readonly maxSize: number) {}

  async processTileModel(scene: Object3D): Promise<void> {
    const textures = new Set<Texture>();
    scene.traverse((obj) => {
      const mat = (obj as Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        const map = (m as MeshStandardMaterial).map;
        if (map) textures.add(map);
      }
    });
    await Promise.all([...textures].map((t) => this.downscale(t)));
  }

  private async downscale(texture: Texture): Promise<void> {
    const image = texture.image as ImageBitmap | HTMLImageElement | undefined;
    if (!image || !('width' in image)) return;
    const scale = this.maxSize / Math.max(image.width, image.height);
    if (scale >= 1) return;
    const resized = await createImageBitmap(image, {
      resizeWidth: Math.max(1, Math.round(image.width * scale)),
      resizeHeight: Math.max(1, Math.round(image.height * scale)),
      resizeQuality: 'medium',
    });
    if ('close' in image) image.close();
    texture.image = resized;
    texture.needsUpdate = true;
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
  private readonly draco = createDracoLoader();
  private resolveReady!: () => void;
  private settledFrames = 0;

  constructor(options: PlateauBuildingsOptions) {
    this.camera = options.camera;
    this.renderer = options.renderer;
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
      tiles.registerPlugin(new TextureDownscalePlugin(options.maxTextureSize ?? 1024));
      tiles.registerPlugin(new LocalFramePlugin(groupMatrix, options.area));
      if (options.area) tiles.registerPlugin(new AreaPlugin(options.area));
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
    this.draco.dispose();
    this.group.removeFromParent();
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    this.resolveReady();
  }
}
