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
 *   航空写真の地面も latLonToLocal で置いているので、どこでも建物の足元と地面が一致する。
 * - 3d-tiles-renderer のカリングと詳細度の判定は、原点の剛体変換（tiles.group.matrix）の座標で行われる。
 *   原点から離れた場所では、表示の位置と判定の位置がずれる（高さ方向に 11.5km で約 10m、
 *   水平にも数 m）。そこで判定には、カメラの位置で平らな地図 → 判定の座標へ写したカメラ（cullCamera）を渡す。
 *
 * 失敗とメモリ:
 * - タイルの取得は `tileFetch.ts` の方針で再試行し、取得できなかったタイルは空のタイルとして扱う
 *   （読み込み完了の判定を止めず、ライブラリにタイルごとのエラーを出させない）。
 * - LRU キャッシュは層（このクラスの 1 インスタンス）ごとに持ち、上限は `budget.ts` で端末に合わせて選ぶ。
 * - テクスチャは画像の復号の時点で縮小する。頂点の位置・索引・_batchid 以外は GPU へ転送した後に解放する。
 */
import { Box3, Color, Group, Matrix4, MeshBasicMaterial, PerspectiveCamera, Vector3 } from 'three';
import type {
  BufferAttribute,
  Camera,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Texture,
  WebGLRenderer,
} from 'three';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
   * 表示する範囲を、ローカル座標の鉛直な円柱の内側か外側に限る。
   * - inside: 円に掛かるタイルだけを読み、カメラの位置によらず最も細かいタイルまで読む。円の外の部分は描かない。
   * - outside: 円にすっぽり入るタイルは読まない。円の内の部分は描かない。
   * 同じ円で inside（テクスチャ付き）と outside（テクスチャなし）の 2 層を重ねると、境界で建物が二重にならない。
   */
  area?: { x: number; z: number; radiusM: number; side: 'inside' | 'outside' };
  /**
   * テクスチャの長辺の上限(px)。PLATEAU のテクスチャは 1 タイルで最大 4096px 四方あり、そのままでは
   * GPU メモリを使い切るので、復号の時点で縮小する。既定は plateauMemoryBudget()（パソコン 1024・スマートフォン 512）。
   */
  maxTextureSize?: number;
  /**
   * この層の LRU キャッシュの上限。既定は plateauMemoryBudget()。
   * 上限に達すると新しいタイルを読まないので、表示に要るタイルが収まる大きさにする。
   */
  cache?: Partial<BuildingCacheBudget>;
  /** タイル取得の再試行の方針（回数・間隔）。 */
  fetchPolicy?: TileFetchPolicyOptions;
}

export type BuildingArea = NonNullable<PlateauBuildingsOptions['area']>;

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
    // 縮尺を含む（せん断を含みうる）行列なので、位置・回転・拡大に分解せずに行列のまま持つ
    scene.matrix.premultiply(this.local).premultiply(this.groupInverse);
    scene.matrixAutoUpdate = false;
    scene.updateMatrixWorld(true);
    const area = this.area;
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as MeshStandardMaterial;
      if (!Array.isArray(mesh.material)) {
        if (mat.map) {
          // 写真テクスチャは撮影時の陰影を含むので、地面の航空写真と同じく照明を当てずに貼る
          const basic = new MeshBasicMaterial({ map: mat.map, side: mat.side, vertexColors: mat.vertexColors });
          basic.name = mat.name;
          mat.dispose();
          mesh.material = basic;
        } else if (mat.isMeshStandardMaterial) {
          // 屋上の設備など（BuildingInstallation）は metallicFactor 0.67 で、環境マップのない場面では
          // 金属の反射で暗くなる。金属にしないで、頂点カラーに照明を当てて描く
          mat.metalness = 0;
        }
      }
      if (area) {
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) clipMaterialToArea(m, area);
      }
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ((m as MeshBasicMaterial).map) fillUntexturedTexels(m);
      }
      for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        if (!KEEP_ATTRIBUTES.has(name)) releaseAfterUpload(attribute as BufferAttribute);
      }
    });
  }
}

/** 写真のない面を塗る色（テクスチャなしの建物の明るい面に近い灰色）。 */
const UNTEXTURED_FILL = new Color('#a7a9ab');

/**
 * テクスチャの真っ黒な画素を灰色で塗るように、マテリアルのシェーダーを書き換える。
 * PLATEAU のテクスチャのアトラスは未使用の領域が黒（RGB=0）で、写真のない面（屋上の設備など）の UV がそこを指すため、
 * そのままでは黒く塗りつぶされる。写真の暗い部分（影）は sRGB で 4/255 以上あるので残る。
 * 既にある onBeforeCompile（円での切り抜き）の後ろにつなぐ。
 */
function fillUntexturedTexels(material: Material): void {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.ptmFill = { value: UNTEXTURED_FILL };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 ptmFill;')
      .replace(
        '#include <map_fragment>',
        // map_fragment の後の diffuseColor は線形の色。sRGB 4/255 ≒ 線形 0.0012
        '#include <map_fragment>\nif (max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b) < 0.0012) diffuseColor.rgb = ptmFill;',
      );
  };
  material.customProgramCacheKey = () => `${previousKey()}-ptm-fill`;
  material.needsUpdate = true;
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

/** 画像の先頭のバイト列から、幅と高さを読む（PNG・JPEG・WebP）。読めなければ null。 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  const u32be = (i: number): number => u16be(i) * 65536 + u16be(i + 2);
  const u24le = (i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
  const ascii = (i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));
  // PNG: IHDR の幅・高さ
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return { width: u32be(16), height: u32be(20) };
  // WebP: RIFF....WEBP の最初のチャンク
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
    return null;
  }
  // JPEG: SOFn マーカーの幅・高さ
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(i + 7), height: u16be(i + 5) };
      }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

/** 先頭から読むバイト数（JPEG の Exif などを越えて SOF に届く大きさ）。 */
const HEADER_BYTES = 256 * 1024;

/**
 * glTF の画像を、復号の時点で長辺 maxSize 以下に縮小して読むローダー（GLTFLoader の ImageBitmapLoader の代わり）。
 * 画像の大きさをヘッダーから読み、createImageBitmap の resizeWidth・resizeHeight で縮小する。
 */
class DownscalingImageLoader {
  readonly isImageBitmapLoader = true;

  constructor(private readonly maxSize: number) {}

  load(url: string, onLoad: (image: ImageBitmap) => void, _onProgress?: unknown, onError?: (err: unknown) => void): void {
    void this.decode(url).then(onLoad, (err: unknown) => onError?.(err));
  }

  private async decode(url: string): Promise<ImageBitmap> {
    const blob = await (await fetch(url)).blob();
    const options: ImageBitmapOptions = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
    const size = readImageSize(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
    if (size && size.width > 0 && size.height > 0) {
      const scale = this.maxSize / Math.max(size.width, size.height);
      if (scale < 1) {
        options.resizeWidth = Math.max(1, Math.round(size.width * scale));
        options.resizeHeight = Math.max(1, Math.round(size.height * scale));
        options.resizeQuality = 'medium';
      }
    }
    return createImageBitmap(blob, options);
  }
}

/** GLTFLoader のプラグイン: 画像の読み込みを DownscalingImageLoader に差し替える。 */
function downscaleTexturesOnDecode(maxSize: number): (parser: GLTFParser) => GLTFLoaderPlugin {
  return (parser) => {
    // createImageBitmap が使えないブラウザ（TextureLoader を使う場合）はそのまま。後段の縮小で補う
    if ((parser.textureLoader as { isImageBitmapLoader?: boolean }).isImageBitmapLoader) {
      (parser as unknown as { textureLoader: unknown }).textureLoader = new DownscalingImageLoader(maxSize);
    }
    return { name: 'PTM_DOWNSCALE_ON_DECODE' };
  };
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


/**
 * 復号の時点で縮小できなかった大きすぎるテクスチャを、読み込み後に縮小するプラグイン
 * （画像の大きさをヘッダーから読めなかったとき・TextureLoader を使うブラウザのときの予備）。
 */
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
  private readonly draco = createDracoLoader();
  /** この層の tileset が共有する LRU キャッシュ。 */
  private readonly lruCache = new LRUCache();
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
    this.group.name = 'plateau-buildings';
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    const budget = plateauMemoryBudget();
    const cache = { ...budget.buildingCache, ...options.cache };
    this.lruCache.unloadPriorityCallback = DEFAULT_LRU_CACHE.unloadPriorityCallback;
    this.lruCache.minBytesSize = cache.minBytes;
    this.lruCache.maxBytesSize = Math.max(cache.maxBytes, cache.minBytes);
    this.lruCache.minSize = cache.minTiles;
    this.lruCache.maxSize = Math.max(cache.maxTiles, cache.minTiles);
    this.fetchPolicy = new TileFetchPolicy('建物', options.fetchPolicy);
    const maxTextureSize = options.maxTextureSize ?? budget.maxTextureSize;

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
      tiles.registerPlugin(
        new GLTFExtensionsPlugin({
          dracoLoader: this.draco,
          autoDispose: false,
          plugins: [downscaleTexturesOnDecode(maxTextureSize)],
        }),
      );
      tiles.registerPlugin(new TextureDownscalePlugin(maxTextureSize));
      tiles.registerPlugin(new LocalFramePlugin(this.groupMatrix, options.area));
      if (options.area) tiles.registerPlugin(new AreaPlugin(options.area));
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
    this.draco.dispose();
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
