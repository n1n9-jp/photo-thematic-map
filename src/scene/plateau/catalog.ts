/**
 * `public/data/plateau/tilesets.json`（`npm run data:plateau` で生成）の型と、視点の近くの区を選ぶ関数。
 */

import { assetUrl } from '../../paths';

export type TilesetVariant = 'lod2_texture' | 'lod2_no_texture' | 'lod1';

export interface WardTilesets {
  code: string;
  name: string;
  year: number;
  /** 度。高さは楕円体高(m)。 */
  bounds: { west: number; south: number; east: number; north: number; minHeight: number; maxHeight: number };
  tilesets: Partial<Record<TilesetVariant, string>>;
}

export interface PlateauCatalog {
  source: string;
  attribution: string;
  year: number;
  generatedAt: string;
  wards: WardTilesets[];
}

export async function loadPlateauCatalog(url = assetUrl('data/plateau/tilesets.json')): Promise<PlateauCatalog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PLATEAU カタログを読めません: ${res.status} ${url}`);
  return (await res.json()) as PlateauCatalog;
}

/**
 * 地点 (lat, lon) から radiusM 以内に範囲が掛かる区の tileset URL を返す。
 * 指定した種類が無い区は、LOD2 テクスチャ付き → LOD2 テクスチャなし → LOD1 の順に代わりを使う。
 */
export function selectTilesets(
  catalog: PlateauCatalog,
  lat: number,
  lon: number,
  radiusM: number,
  variant: TilesetVariant = 'lod2_texture',
): string[] {
  const dLat = radiusM / 111_000;
  const dLon = radiusM / (111_000 * Math.cos((lat * Math.PI) / 180));
  const order: TilesetVariant[] = [variant, 'lod2_texture', 'lod2_no_texture', 'lod1'];
  const urls: string[] = [];
  for (const ward of catalog.wards) {
    const b = ward.bounds;
    if (lat + dLat < b.south || lat - dLat > b.north || lon + dLon < b.west || lon - dLon > b.east) continue;
    const url = order.map((v) => ward.tilesets[v]).find((u) => u !== undefined);
    if (url) urls.push(url);
  }
  return urls;
}
