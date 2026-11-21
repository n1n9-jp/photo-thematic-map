/**
 * 航空写真（`PlateauGround`）の下に敷く、単色の地面と海。
 *
 * 航空写真のタイルがない範囲（東京湾の海、都の西側の一部、隣の県）が背景の空の色で抜けて見えないよう、
 * 航空写真より少し下に、広い範囲を覆う面を置く。
 *
 * - 陸の色: 航空写真の陸地（遠景）の平均に近い、落ち着いた灰色。カメラの真下に追従する正方形の1枚。
 * - 海の色: 青灰色。海陸マスク（`public/data/basemap/landmask.png`、国土地理院の標高の無効値から作る。`src/geo/landmask.ts`）の
 *   範囲（関東の沿岸）だけ、陸の面のすぐ上に重ねる。航空写真の海の上は透明なので、東京湾はこの色で見える。
 *   マスクを読めないときは、陸の色だけで敷く。
 * - 霧は他の地面と同じ（遠くは空の色に溶ける）。航空写真との重なりでちらつかないよう、面は標高 BASE_Y(m) に置く。
 *   航空写真の地面（標高 0m 以上、側面のスカートでも -2m 程度まで）より十分下で、俯瞰では見分けがつかない差。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import type { PerspectiveCamera } from 'three';
import { LANDMASK } from '../../geo/landmask';
import { latLonToLocal } from '../../geo/enu';
import { latToTileY, tileXToLon, tileYToLat } from '../../geo/tiles';
import { assetUrl } from '../../paths';
import { fetchImagePixels } from './elevation';

/** 陸の色（航空写真の陸地の遠景の平均に近い灰色）。 */
export const BASE_LAND_COLOR = 0x77746d;
/** 海の色（落ち着いた青灰色）。 */
export const BASE_SEA_COLOR = 0x5f7f96;
/** 面を置く標高(m)。 */
export const BASE_Y = -12;
/** 海の面は、陸の面より（標高で）この分だけ上。 */
const SEA_LIFT_M = 1;
/** 陸の面の半径(m)。カメラの far の上限（400km）を覆う。 */
const LAND_RADIUS_M = 450_000;
/** 陸の面の中心を動かす刻み(m)。カメラの動きごとに面が動いて見えないようにする。 */
const LAND_SNAP_M = 10_000;
/** 海の面の分割数（メルカトルの縦の伸びを、頂点ごとの UV で正しく写す）。 */
const SEA_SEGMENTS = 32;

export class BaseGround {
  readonly group = new Group();
  /** 海陸マスクを読み終える（読めなくても）と解決する。 */
  readonly ready: Promise<void>;
  /** マスクを読み込み中か。 */
  isLoading = true;
  private readonly land: Mesh;
  private sea: Mesh | null = null;
  private disposed = false;

  constructor(maskUrl: string = assetUrl(LANDMASK.path)) {
    this.group.name = 'plateau-base-ground';
    const r = LAND_RADIUS_M;
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-r, 0, -r, r, 0, -r, -r, 0, r, r, 0, r]), 3),
    );
    geometry.setIndex([0, 2, 1, 1, 2, 3]);
    this.land = new Mesh(geometry, new MeshBasicMaterial({ color: BASE_LAND_COLOR, side: DoubleSide }));
    this.land.name = 'base-land';
    this.land.position.y = BASE_Y;
    this.land.frustumCulled = false;
    this.land.renderOrder = -1;
    this.group.add(this.land);
    this.ready = this.loadMask(maskUrl);
  }

  /** 毎フレーム、描画の前に呼ぶ。陸の面をカメラの真下に追従させる。 */
  update(camera: PerspectiveCamera): void {
    this.land.position.x = Math.round(camera.position.x / LAND_SNAP_M) * LAND_SNAP_M;
    this.land.position.z = Math.round(camera.position.z / LAND_SNAP_M) * LAND_SNAP_M;
    this.land.updateMatrix();
  }

  dispose(): void {
    this.disposed = true;
    for (const mesh of [this.land, this.sea]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      const m = mesh.material as MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    }
    this.sea = null;
    this.group.removeFromParent();
  }

  private async loadMask(url: string): Promise<void> {
    try {
      const img = await fetchImagePixels(url);
      if (!img || this.disposed) {
        img?.bitmap.close();
        return;
      }
      const { width, height } = img.bitmap;
      img.bitmap.close();
      // 画像は 1 が海（白）。アルファだけを使うので、色は全画素で白にする（色は材質の color）。
      const data = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        data[i * 4] = 255;
        data[i * 4 + 1] = 255;
        data[i * 4 + 2] = 255;
        data[i * 4 + 3] = (img.pixels[i * 4] ?? 0) > 127 ? 255 : 0;
      }
      const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
      texture.flipY = false;
      texture.generateMipmaps = false;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.needsUpdate = true;
      const material = new MeshBasicMaterial({
        color: new Color(BASE_SEA_COLOR),
        map: texture,
        alphaTest: 0.5,
        side: DoubleSide,
      });
      const sea = new Mesh(buildSeaGeometry(), material);
      sea.name = 'base-sea';
      sea.position.y = BASE_Y + SEA_LIFT_M;
      sea.frustumCulled = false;
      sea.renderOrder = -1;
      this.sea = sea;
      this.group.add(sea);
    } catch (err) {
      // 海陸マスクがなくても陸の色だけで描ける
      console.warn('海陸マスクを読み込めませんでした', err);
    } finally {
      this.isLoading = false;
    }
  }
}

/** 海陸マスクの範囲を覆う格子。頂点は緯度経度から置き、UV は画像（メルカトル）の位置。 */
function buildSeaGeometry(): BufferGeometry {
  const { z, x0, y0, tilesX, tilesY } = LANDMASK;
  const n = SEA_SEGMENTS;
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  const uv = new Float32Array((n + 1) * (n + 1) * 2);
  const index: number[] = [];
  // 緯度は等間隔ではなくメルカトルの y で等間隔に刻む（画像の画素と頂点の対応を保つ）
  for (let j = 0; j <= n; j++) {
    const lat = tileYToLat(y0 + (tilesY * j) / n, z);
    for (let i = 0; i <= n; i++) {
      const lon = tileXToLon(x0 + (tilesX * i) / n, z);
      const p = latLonToLocal({ lat, lon, alt: 0 });
      const k = j * (n + 1) + i;
      pos[k * 3] = p.x;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = p.z;
      uv[k * 2] = i / n;
      uv[k * 2 + 1] = (latToTileY(lat, z) - y0) / tilesY;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + n + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}
