/**
 * 国土地理院の標高タイル（PNG）とジオイド高。
 *
 * - 標高タイル: https://maps.gsi.go.jp/development/demtile.html
 *   画素の値 x = R·2^16 + G·2^8 + B。x < 2^23 なら x·0.01 m、x = 2^23 は無効値、x > 2^23 なら (x − 2^24)·0.01 m。
 *   高さは標高（ジオイドからの高さ）。
 */
import { GSI_DEM5A_URL, GSI_DEM5A_ZOOM } from '../../src/config';
import { fetchCached, mapLimit } from './cache';
import { decodePng } from './png';

export interface DemSource {
  id: string;
  /** {z}/{x}/{y} を含む URL。 */
  url: string;
  zoom: number;
  description: string;
}

/**
 * 使う標高タイル。街並みの表示（src/scene/plateau/elevation.ts）と同じ取得元（src/config.ts）。
 * 表示は 5m メッシュの無効値を 10m メッシュで補うが、10m メッシュは水面（お濠・川）で岸より数 m 高い値を返すので、
 * 格子では使わず、無効値のセル（主に水面）は焼き込み側で近傍の最も低い地面の値で埋める。
 */
export const DEM_SOURCES: DemSource[] = [
  { id: 'dem5a', url: GSI_DEM5A_URL, zoom: GSI_DEM5A_ZOOM, description: '国土地理院 基盤地図情報 数値標高モデル 5m メッシュ（航空レーザ測量）' },
];

const TILE = 256;

interface DemTile {
  values: Float32Array;
}

/** 1 つの標高タイルの集合。緯度経度で双一次補間した標高を返す。 */
export class DemLayer {
  readonly source: DemSource;
  private tiles = new Map<string, DemTile | null>();
  usedTiles = 0;
  constructor(source: DemSource) {
    this.source = source;
  }

  private key(x: number, y: number): string {
    return `${x}/${y}`;
  }

  /** 緯度経度の範囲を覆うタイルを取得する。 */
  async prefetch(south: number, west: number, north: number, east: number): Promise<void> {
    const z = this.source.zoom;
    const [x0, y0] = tileXY(north, west, z);
    const [x1, y1] = tileXY(south, east, z);
    const list: [number, number][] = [];
    for (let y = Math.floor(y0) - 1; y <= Math.floor(y1) + 1; y++) {
      for (let x = Math.floor(x0) - 1; x <= Math.floor(x1) + 1; x++) list.push([x, y]);
    }
    await mapLimit(list, 6, async ([x, y]) => {
      const k = this.key(x, y);
      if (this.tiles.has(k)) return;
      const url = this.source.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      const buf = await fetchCached(url, { allow404: true });
      if (!buf) {
        this.tiles.set(k, null);
        return;
      }
      const img = decodePng(buf);
      if (img.width !== TILE || img.height !== TILE) throw new Error(`標高タイルの大きさが不正です: ${url}`);
      const values = new Float32Array(TILE * TILE);
      for (let i = 0; i < TILE * TILE; i++) {
        const r = img.data[i * img.channels] as number;
        const g = img.data[i * img.channels + 1] as number;
        const b = img.data[i * img.channels + 2] as number;
        const v = r * 65536 + g * 256 + b;
        values[i] = v === 8388608 ? Number.NaN : v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
      }
      this.tiles.set(k, { values });
      this.usedTiles++;
    });
  }

  /** 画素 (px, py)（ズーム z の全体の画素座標）の標高。無効値は NaN。 */
  private pixel(px: number, py: number): number {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) return Number.NaN;
    return t.values[(py - ty * TILE) * TILE + (px - tx * TILE)] as number;
  }

  /** 緯度経度の標高(m)。周囲 4 画素のうち有効なものだけで重みを正規化して補間する。全て無効なら NaN。 */
  sample(lat: number, lon: number): number {
    const [tx, ty] = tileXY(lat, lon, this.source.zoom);
    // 画素の中心が整数 + 0.5 にある。
    const gx = tx * TILE - 0.5;
    const gy = ty * TILE - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    let s = 0;
    let w = 0;
    const add = (px: number, py: number, wt: number): void => {
      if (wt <= 0) return;
      const v = this.pixel(px, py);
      if (Number.isNaN(v)) return;
      s += v * wt;
      w += wt;
    };
    add(x0, y0, (1 - fx) * (1 - fy));
    add(x0 + 1, y0, fx * (1 - fy));
    add(x0, y0 + 1, (1 - fx) * fy);
    add(x0 + 1, y0 + 1, fx * fy);
    return w > 1e-9 ? s / w : Number.NaN;
  }
}

/** 緯度経度 → ズーム z のタイル座標（小数）。 */
export function tileXY(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}
