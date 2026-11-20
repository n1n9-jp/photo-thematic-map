/**
 * PLATEAU データカタログ API から東京23区の建物 3D Tiles の URL を抜き出し、
 * public/data/plateau/tilesets.json に書き出す。
 *
 * 実行: npm run data:plateau（Node 22 の型除去で .ts を直接実行する）
 *
 * 各区について 2025 年度の
 *   - LOD2 テクスチャ付き（lod2_texture）
 *   - LOD2 テクスチャなし（lod2_no_texture）
 *   - LOD1（lod1）
 * を拾い、範囲（ルートタイルの boundingVolume.region を度に換算）も添える。
 * 範囲はアプリが視点の近くの区だけを読み込むために使う。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const YEAR = 2025;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data/plateau/tilesets.json');

/** 東京23区の市区町村コード（13101 千代田区 〜 13123 江戸川区）。 */
const WARD_CODES = Array.from({ length: 23 }, (_, i) => String(13101 + i));

type Variant = 'lod2_texture' | 'lod2_no_texture' | 'lod1';

interface CatalogItem {
  pref_code: string;
  city: string;
  city_code: string;
  type_en: string;
  lod: string | null;
  texture: boolean | null;
  year: number;
  format: string;
  url: string;
}

interface WardEntry {
  code: string;
  name: string;
  year: number;
  /** 度。ルートタイルの region から換算。高さは楕円体高(m)。 */
  bounds: { west: number; south: number; east: number; north: number; minHeight: number; maxHeight: number };
  tilesets: Partial<Record<Variant, string>>;
}

function variantOf(item: CatalogItem): Variant | null {
  if (item.lod === '2') return item.texture === false ? 'lod2_no_texture' : 'lod2_texture';
  if (item.lod === '1') return 'lod1';
  return null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return (await res.json()) as T;
}

async function rootRegion(tilesetUrl: string): Promise<WardEntry['bounds']> {
  const ts = await fetchJson<{ root: { boundingVolume: { region?: number[] } } }>(tilesetUrl);
  const r = ts.root.boundingVolume.region;
  if (!r || r.length !== 6) throw new Error(`region がありません: ${tilesetUrl}`);
  const deg = (v: number): number => Math.round(((v * 180) / Math.PI) * 1e7) / 1e7;
  const [w, s, e, n, minH, maxH] = r as [number, number, number, number, number, number];
  return { west: deg(w), south: deg(s), east: deg(e), north: deg(n), minHeight: minH, maxHeight: maxH };
}

async function main(): Promise<void> {
  console.log(`カタログを取得: ${CATALOG_URL}`);
  const catalog = await fetchJson<{ datasets: CatalogItem[] }>(CATALOG_URL);
  const bldg = catalog.datasets.filter(
    (d) => d.type_en === 'bldg' && d.format === '3D Tiles' && d.year === YEAR && WARD_CODES.includes(d.city_code),
  );

  const wards: WardEntry[] = [];
  for (const code of WARD_CODES) {
    const items = bldg.filter((d) => d.city_code === code);
    const first = items[0];
    if (!first) {
      console.warn(`${code}: ${YEAR}年度の建物 3D Tiles がありません`);
      continue;
    }
    const tilesets: WardEntry['tilesets'] = {};
    for (const item of items) {
      const v = variantOf(item);
      if (v && !tilesets[v]) tilesets[v] = item.url;
    }
    const boundsUrl = tilesets.lod1 ?? tilesets.lod2_texture ?? tilesets.lod2_no_texture;
    if (!boundsUrl) continue;
    const bounds = await rootRegion(boundsUrl);
    wards.push({ code, name: first.city, year: YEAR, bounds, tilesets });
    console.log(`${code} ${first.city}: ${Object.keys(tilesets).join(', ')}`);
  }

  const out = {
    source: CATALOG_URL,
    attribution: '出典：国土交通省 Project PLATEAU（https://www.mlit.go.jp/plateau/）',
    year: YEAR,
    generatedAt: new Date().toISOString(),
    wards,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${wards.length} 区を書き出しました: ${OUT}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
