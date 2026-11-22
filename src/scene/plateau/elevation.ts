/**
 * 国土地理院 標高タイル（PNG）の読み込みと標高の参照。
 *
 * - 5m メッシュ（dem5a_png、ズーム15のみ、航空レーザー測量）を主に使い、
 *   無効値（水面など）や未整備の場所は 10m メッシュ（dem_png、ズーム14まで）で補う。
 * - 標高は「標高(m)」（東京湾平均海面基準）で、ローカル Y にそのまま対応する（ORIGIN.alt=0 のとき）。
 * 仕様: https://maps.gsi.go.jp/development/demtile.html
 */
import { GSI_DEM10_MAX_ZOOM, GSI_DEM10_URL, GSI_DEM5A_URL, GSI_DEM5A_ZOOM } from '../../config';
import { decodeGsiDemPixel, latToTileY, lonToTileX } from '../../geo/tiles';
import { plateauMemoryBudget } from './budget';
import { TileFetchPolicy, TileUnavailableError } from './tileFetch';

export type DemKind = 'dem5a' | 'dem10';

/** 256×256 の標高格子。無効値は NaN。 */
export interface DemTile {
  kind: DemKind;
  z: number;
  x: number;
  y: number;
  heights: Float32Array;
}

const SIZE = 256;

function demUrl(kind: DemKind, z: number, x: number, y: number): string {
  const tpl = kind === 'dem5a' ? GSI_DEM5A_URL : GSI_DEM10_URL;
  return tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/**
 * 画像（PNG）を取得して RGBA 画素を返す。色空間変換・乗算済みアルファを無効にして値を保つ。
 * 存在しない（404 など）なら null。policy を渡すと、その再試行の方針で取得する
 * （取得不能なら TileUnavailableError を投げる）。
 */
export async function fetchImagePixels(
  url: string,
  signal?: AbortSignal,
  policy?: TileFetchPolicy,
): Promise<{ bitmap: ImageBitmap; pixels: Uint8ClampedArray } | null> {
  let res: Response | null;
  if (policy) {
    res = await policy.fetch(url, { signal });
  } else {
    res = await fetch(url, { signal });
    if (!res.ok) res = null;
  }
  if (!res) return null;
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D コンテキストを作れません');
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return { bitmap, pixels };
}

/** RGBA 画素列を標高格子に復号する。 */
export function decodeDemPixels(pixels: ArrayLike<number>): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const h = decodeGsiDemPixel(pixels[i * 4] ?? 0, pixels[i * 4 + 1] ?? 0, pixels[i * 4 + 2] ?? 0);
    out[i] = h ?? Number.NaN;
  }
  return out;
}

/**
 * タイル内の小数画素位置 (px, py)（0〜256）で双線形補間した標高。周囲に無効値があれば NaN。
 */
export function sampleDem(tile: DemTile, px: number, py: number): number {
  const fx = Math.min(Math.max(px - 0.5, 0), SIZE - 1);
  const fy = Math.min(Math.max(py - 0.5, 0), SIZE - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, SIZE - 1);
  const y1 = Math.min(y0 + 1, SIZE - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const h = tile.heights;
  const a = h[y0 * SIZE + x0] ?? Number.NaN;
  const b = h[y0 * SIZE + x1] ?? Number.NaN;
  const c = h[y1 * SIZE + x0] ?? Number.NaN;
  const d = h[y1 * SIZE + x1] ?? Number.NaN;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** 緯度経度で DEM タイルを参照する。タイル外・無効値なら NaN。 */
export function sampleDemAt(tile: DemTile, lat: number, lon: number): number {
  const px = (lonToTileX(lon, tile.z) - tile.x) * SIZE;
  const py = (latToTileY(lat, tile.z) - tile.y) * SIZE;
  if (px < 0 || py < 0 || px > SIZE || py > SIZE) return Number.NaN;
  return sampleDem(tile, px, py);
}

/** 格子の部分範囲（画素単位の矩形）に有効値が 1 つでもあるか。 */
export function hasValidHeights(tile: DemTile, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!Number.isNaN(tile.heights[y * SIZE + x] ?? Number.NaN)) return true;
    }
  }
  return false;
}

export interface GsiElevationSourceOptions {
  /** キャッシュする標高タイルの上限（1 枚 256KB）。既定は端末に合わせて plateauMemoryBudget() から選ぶ。 */
  maxTiles?: number;
  /** 再試行の方針。既定は「標高」の名前で新しく作る。 */
  policy?: TileFetchPolicy;
  /** 画像の取得（単体テストで差し替える）。既定は fetchImagePixels。 */
  fetchPixels?: FetchPixels;
}

/** 画像を取得して RGBA 画素を返す関数（fetchImagePixels と同じ形）。 */
export type FetchPixels = typeof fetchImagePixels;

/**
 * 標高タイルの取得とキャッシュ（LRU）。
 * 取得できなかったタイル（存在しない・上限まで再試行しても失敗）は null として覚え、要求し直さない。
 */
export class GsiElevationSource {
  /** 再試行の方針（失敗の件数は failedTileCount）。 */
  readonly policy: TileFetchPolicy;
  private readonly maxTiles: number;
  private readonly fetchPixels: FetchPixels;
  /** 挿入順＝使った順（古い順）。 */
  private readonly cache = new Map<string, Promise<DemTile | null>>();

  constructor(options: GsiElevationSourceOptions = {}) {
    this.maxTiles = Math.max(1, options.maxTiles ?? plateauMemoryBudget().elevationMaxTiles);
    this.policy = options.policy ?? new TileFetchPolicy('標高');
    this.fetchPixels = options.fetchPixels ?? fetchImagePixels;
  }

  /** 取得不能になった標高タイルの件数。 */
  get failedTileCount(): number {
    return this.policy.failedCount;
  }

  /** キャッシュしている標高タイルの数。 */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 標高タイルを取得する（同じタイルは 1 回だけ取得）。存在しない・取得できなければ null。
   * キャッシュから外れたタイルも、呼び出し側が持っている参照は使い続けられる。
   */
  getTile(kind: DemKind, z: number, x: number, y: number): Promise<DemTile | null> {
    const key = `${kind}/${z}/${x}/${y}`;
    let p = this.cache.get(key);
    if (p) {
      // 使った順に並べ直す
      this.cache.delete(key);
      this.cache.set(key, p);
      return p;
    }
    p = this.fetchPixels(demUrl(kind, z, x, y), undefined, this.policy).then(
      (img) => {
        if (!img) return null;
        img.bitmap.close();
        return { kind, z, x, y, heights: decodeDemPixels(img.pixels) };
      },
      (err: unknown) => {
        if (err instanceof TileUnavailableError) return null;
        // 復号の失敗など。キャッシュに残さず、次に要求されたときに取り直す
        if (this.cache.get(key) === p) this.cache.delete(key);
        throw err;
      },
    );
    this.cache.set(key, p);
    while (this.cache.size > this.maxTiles) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return p;
  }

  /** キャッシュを空にする。 */
  dispose(): void {
    this.cache.clear();
  }

  /**
   * 指定地点の標高(m)。5m メッシュ → 10m メッシュの順に参照し、どちらも無効なら 0。
   * 海上などタイルが存在しない場所ではブラウザが 404 をコンソールに記録する点に注意。
   * 標高タイルを取得できないとき（配信サーバーに接続できないなど）も 0 を返す。
   */
  async elevationAt(lat: number, lon: number): Promise<number> {
    const z5 = GSI_DEM5A_ZOOM;
    const t5 = await this.getTile('dem5a', z5, Math.floor(lonToTileX(lon, z5)), Math.floor(latToTileY(lat, z5)));
    const h5 = t5 ? sampleDemAt(t5, lat, lon) : Number.NaN;
    if (!Number.isNaN(h5)) return h5;
    const z10 = GSI_DEM10_MAX_ZOOM;
    const t10 = await this.getTile('dem10', z10, Math.floor(lonToTileX(lon, z10)), Math.floor(latToTileY(lat, z10)));
    const h10 = t10 ? sampleDemAt(t10, lat, lon) : Number.NaN;
    return Number.isNaN(h10) ? 0 : h10;
  }
}
