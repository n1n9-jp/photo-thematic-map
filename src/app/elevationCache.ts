/**
 * 標高の同期参照。語りのカメラリグは毎フレーム同期で地表の高さを求めるので、
 * 標高タイル（非同期）を先に読み、読み込んだタイルから同期で引けるようにする。
 *
 * - `prefetch(lat, lon)`: その地点の標高タイル（5m メッシュ、無効値なら 10m メッシュ）を読み、標高を返す。
 * - `heightAt(lat, lon)`: 読み込み済みのタイルから標高を返す。タイルが無ければ、prefetch した地点のうち
 *   最も近い地点の標高（目安）を返す。存在しないタイル（海など）を要求して 404 を出さないよう、ここでは読み込まない。
 */
import { GSI_DEM10_MAX_ZOOM, GSI_DEM5A_ZOOM } from '../config';
import { latToTileY, lonToTileX } from '../geo/tiles';
import { sampleDemAt, type DemKind, type DemTile, type GsiElevationSource } from '../scene/plateau/elevation';

interface Known {
  lat: number;
  lon: number;
  h: number;
}

function tileKey(kind: DemKind, lat: number, lon: number): { kind: DemKind; z: number; x: number; y: number; key: string } {
  const z = kind === 'dem5a' ? GSI_DEM5A_ZOOM : GSI_DEM10_MAX_ZOOM;
  const x = Math.floor(lonToTileX(lon, z));
  const y = Math.floor(latToTileY(lat, z));
  return { kind, z, x, y, key: `${kind}/${z}/${x}/${y}` };
}

export class ElevationCache {
  private readonly tiles = new Map<string, DemTile | null>();
  private readonly known: Known[] = [];

  constructor(private readonly source: GsiElevationSource) {}

  /** 地点の標高(m)を読み込む。以後 `heightAt` でその周りを同期で引ける。 */
  async prefetch(lat: number, lon: number): Promise<number> {
    const h = await this.source.elevationAt(lat, lon);
    // elevationAt が読んだタイル（キャッシュ済み）を手元にも置く。5m が無効なら 10m も読まれている。
    for (const kind of ['dem5a', 'dem10'] as const) {
      const t = tileKey(kind, lat, lon);
      if (this.tiles.has(t.key)) continue;
      if (kind === 'dem10' && this.sample('dem5a', lat, lon) !== null) continue;
      this.tiles.set(t.key, await this.source.getTile(kind, t.z, t.x, t.y));
    }
    this.known.push({ lat, lon, h });
    return h;
  }

  /** 読み込み済みのタイルから標高(m)。無ければ最も近い既知の地点の値、それも無ければ 0。 */
  heightAt(lat: number, lon: number): number {
    const h5 = this.sample('dem5a', lat, lon);
    if (h5 !== null) return h5;
    const h10 = this.sample('dem10', lat, lon);
    if (h10 !== null) return h10;
    let best = 0;
    let bestD = Infinity;
    for (const k of this.known) {
      const d = (k.lat - lat) ** 2 + ((k.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k.h;
      }
    }
    return best;
  }

  private sample(kind: DemKind, lat: number, lon: number): number | null {
    const tile = this.tiles.get(tileKey(kind, lat, lon).key);
    if (!tile) return null;
    const h = sampleDemAt(tile, lat, lon);
    return Number.isNaN(h) ? null : h;
  }
}
