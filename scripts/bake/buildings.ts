/**
 * 建物の事前変換: 作品のカメラが巡る 3 か所（秋葉原・東京駅丸の内口・新宿の都庁前）について、PLATEAU の建物と
 * 橋梁・高架の形だけを取り出し、本編の座標（平らな地図。Y は標高）に置き直して、軽いチャンクに変換する。
 *
 * 実行: npm run data:buildings [-- --force]
 *   （= node --import ./scripts/bake/register.ts scripts/bake/buildings.ts）
 * 出力: public/data/buildings/manifest.json と <level>/<ix>_<iz>.bin（形式は src/data/buildings.ts）。
 *   出力がそろっていて、入力（このスクリプトと形式・座標変換のコード、範囲を決める台本のカメラ、変換の設定）の
 *   ハッシュが manifest.json の inputHash と同じなら、何もしない（ネットワークにも出ない）。--force で作り直す。
 * 取得したタイルは node_modules/.cache/ptm-bake/ にキャッシュする（scripts/bake/cache.ts）。
 *
 * 範囲と細かさ:
 * - 台本（src/story/content/script.ts）の場面のうち建物を描く場面（place がある場面）を、place ごとにまとめて「場所」とし、
 *   各場面の注視点とカメラの位置を「点」とする。
 * - 詳細（detail）: 点から DETAIL_RADIUS_M 以内に掛かる一辺 CELL_M のセル。LOD2（テクスチャなし）の建物と、
 *   橋梁・高架（LOD2、なければ LOD1）の形をそのまま入れる。
 * - 遠景（far）: 点から FAR_RADIUS_M 以内に掛かる一辺 CELL_M×CELLS_PER_FAR のチャンク。LOD1（箱）の建物のうち、
 *   点からの距離に応じた高さ（FAR_MIN_HEIGHT）以上のものを入れる。チャンクの中はセルごとの群に分けてあり、
 *   本編は詳細を表示しているセルの群を描かない（同じ建物を二重に描かない）。LOD1 の建物は、同じ gml_id の LOD2 の建物と
 *   同じセルに割り当てる。高さ farLod2MinHeightM 以上の建物は、同じ gml_id の LOD2 の形に置き換える。
 * - 建物は足元の中心（頂点の範囲の中心）でセルに割り当てる。形は切らない。
 * - 地面に接する下向きの面（床。地上からは見えない）は捨てる。高架の裏面などは残る。
 *
 * 座標: 頂点ごとに ECEF → 緯度経度・楕円体高（ecefToGeodetic）→ latLonToLocal（高さ = 楕円体高 − GEOID_HEIGHT_M）。
 * 平らな地図の定義どおりで、地面（latLonToLocal で置いている）と足元が一致する。
 *
 * 同じ入力からは同じ出力になる（タイルは URL の順、地物はタイルの中の順に処理し、gzip のヘッダーに時刻を入れない。
 * 生成日は中身が変わらなければ前回の値を据え置く）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { GEOID_HEIGHT_M, ORIGIN } from '../../src/config';
import {
  BUILDING_FORMAT_VERSION,
  BUILDING_MANIFEST_PATH,
  buildingChunkPath,
  encodeBuildingChunk,
  quantizeTriangles,
  type BuildingChunkInfo,
  type BuildingLevel,
  type BuildingManifest,
  type BuildingPlaceInfo,
} from '../../src/data/buildings';
import { ecefToGeodetic } from '../../src/geo/ecef';
import { latLonToLocal, localToLatLon } from '../../src/geo/enu';
import { keyframeToPose, poseToCameraPosition, viewsOf } from '../../src/story/cameraPath';
import { PLACES, SCRIPT } from '../../src/story/content/script';
import { fetchCounts, fetchJsonCached, mapLimit } from './cache';
import { fetchTile, selectLeafTiles, type RegionRad, type TilesetJson } from './tiles';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = join(ROOT, 'public');
const OUT_DIR = join(PUBLIC, 'data/buildings');
const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';

// ---------------------------------------------------------------------------
// 設定（変えると inputHash が変わり、作り直す）
// ---------------------------------------------------------------------------

export const BAKE_PARAMS = {
  /** 詳細のセルの一辺(m)。 */
  cellM: 250,
  /** 遠景のチャンクの一辺（セルの数）。 */
  cellsPerFar: 4,
  /** 点からこの距離(m)に掛かるセルに詳細を出力する。 */
  detailRadiusM: 600,
  /** 点からこの距離(m)に掛かるチャンクに遠景を出力する。 */
  farRadiusM: 5000,
  /** 遠景に入れる建物の高さの下限(m)。建物の足元の中心から最も近い点までの距離ごと。 */
  farMinHeight: [
    { withinM: 1500, minHeightM: 0 },
    { withinM: 3000, minHeightM: 12 },
    { withinM: Infinity, minHeightM: 25 },
  ],
  /** 量子化の刻みの下限(m)。 */
  detailStepM: 0.01,
  farStepM: 0.05,
  /** 地物の最も低い頂点からこの高さ(m)以内にある下向きの面（床）を捨てる。 */
  floorToleranceM: 0.3,
  /**
   * 遠景で、この高さ(m)以上の建物は LOD1 の箱の代わりに LOD2 の形を使う（塔の尖った屋根など、遠くからも目立つ輪郭のため）。
   * LOD1 の高さは計測高さ（屋上まで）で、塔屋や尖塔を含まない。
   */
  farLod2MinHeightM: 100,
} as const;

/** 本編で詳細を使う距離(m)。カメラか注視点からこの距離以内のセル。bake の detailRadiusM と同じにする。 */
export const DETAIL_VIEW_M = BAKE_PARAMS.detailRadiusM;

/** 既知の場所の名前（place の中心が近いものを使う）。 */
const KNOWN_PLACES = [
  { name: 'akihabara', label: '秋葉原駅', ...PLACES.akihabaraSidewalk },
  { name: 'marunouchi', label: '東京駅丸の内口', ...PLACES.tokyoPlaza },
  { name: 'shinjuku', label: '新宿 都庁前・新宿中央公園', ...PLACES.shinjukuPark },
];

// ---------------------------------------------------------------------------

interface CatalogEntry {
  pref: string;
  city: string;
  type_en: string;
  lod: number | string | null;
  texture: boolean | null;
  year: number | string;
  url: string;
  format: string;
}

interface TilesetChoice {
  level: BuildingLevel;
  kind: 'bldg' | 'brid';
  city: string;
  lod: number;
  texture: boolean;
  year: number;
  url: string;
}

interface Point {
  scene: string;
  role: 'target' | 'camera';
  x: number;
  z: number;
  heightM: number;
}

interface Place {
  name: string;
  label: string;
  points: Point[];
}

const round = (v: number, d = 3): number => Number(v.toFixed(d));
const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const cellKey = (ix: number, iz: number): string => `${ix}_${iz}`;

/** 点 (px, pz) と正方形 [x0, x0+s)×[z0, z0+s) の水平距離。 */
function rectDistance(px: number, pz: number, x0: number, z0: number, s: number): number {
  const dx = Math.max(x0 - px, 0, px - (x0 + s));
  const dz = Math.max(z0 - pz, 0, pz - (z0 + s));
  return Math.hypot(dx, dz);
}

/** 台本から場所と点を作る。 */
export function placesFromScript(): Place[] {
  const groups = new Map<string, { lat: number; lon: number; scenes: (typeof SCRIPT)[number][] }>();
  for (const s of SCRIPT) {
    if (!s.place) continue;
    const key = `${s.place.lat},${s.place.lon}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { lat: s.place.lat, lon: s.place.lon, scenes: [] }));
    g.scenes.push(s);
  }
  return [...groups.values()].map((g, i) => {
    const c = latLonToLocal(g);
    let best: (typeof KNOWN_PLACES)[number] | null = null;
    let bestD = 1500;
    for (const k of KNOWN_PLACES) {
      const p = latLonToLocal(k);
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    const points: Point[] = [];
    for (const s of g.scenes) {
      // 横長の画面のカメラと、あれば縦長の画面のカメラ（`StoryCameraKeyframe.portrait`）
      for (const view of viewsOf(s.camera)) {
        const pose = keyframeToPose(view, () => 0);
        const cam = poseToCameraPosition(pose);
        points.push({ scene: s.id, role: 'target', x: round(pose.target.x, 2), z: round(pose.target.z, 2), heightM: round(pose.target.y, 2) });
        points.push({ scene: s.id, role: 'camera', x: round(cam.x, 2), z: round(cam.z, 2), heightM: round(cam.y, 2) });
      }
    }
    // 同じ位置の点（場面1 と 8 など）は 1 つにする
    const seen = new Set<string>();
    const unique = points.filter((p) => {
      const k = `${p.role}:${p.x},${p.z}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { name: best?.name ?? `place${i + 1}`, label: best?.label ?? `場所${i + 1}`, points: unique };
  });
}

/** 点から radius 以内に掛かる、一辺 size の正方形の番号。 */
function cellsNear(points: readonly Point[], size: number, radius: number): Set<string> {
  const out = new Set<string>();
  for (const p of points) {
    const i0 = Math.floor((p.x - radius) / size);
    const i1 = Math.floor((p.x + radius) / size);
    const j0 = Math.floor((p.z - radius) / size);
    const j1 = Math.floor((p.z + radius) / size);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (rectDistance(p.x, p.z, i * size, j * size, size) <= radius) out.add(cellKey(i, j));
      }
    }
  }
  return out;
}

const parseKey = (k: string): [number, number] => k.split('_').map(Number) as [number, number];
const sortKeys = (keys: Iterable<string>): string[] =>
  [...keys].sort((a, b) => {
    const [ai, aj] = parseKey(a);
    const [bi, bj] = parseKey(b);
    return aj - bj || ai - bi;
  });

/** 正方形の集まりを囲む緯度経度の範囲（ラジアン）。 */
function regionOf(keys: Iterable<string>, size: number): RegionRad {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const k of keys) {
    const [i, j] = parseKey(k);
    x0 = Math.min(x0, i * size);
    x1 = Math.max(x1, (i + 1) * size);
    z0 = Math.min(z0, j * size);
    z1 = Math.max(z1, (j + 1) * size);
  }
  // 建物は足元の中心で割り当てるので、はみ出しのぶん少し広く読む
  const m = 150;
  const sw = localToLatLon({ x: x0 - m, y: 0, z: z1 + m });
  const ne = localToLatLon({ x: x1 + m, y: 0, z: z0 - m });
  const r = Math.PI / 180;
  return { west: sw.lon * r, south: sw.lat * r, east: ne.lon * r, north: ne.lat * r };
}

/** 区ごとに使うタイルセットを選ぶ（最新の年度）。 */
function chooseTilesets(catalog: CatalogEntry[]): TilesetChoice[] {
  const out: TilesetChoice[] = [];
  const all = catalog
    .filter((d) => d.pref === '東京都' && typeof d.city === 'string' && d.city.endsWith('区') && d.format === '3D Tiles')
    .map((d) => ({ ...d, lod: Number(d.lod), year: Number(d.year) }));
  const cities = [...new Set(all.map((d) => d.city))].sort();
  const pick = (city: string, kind: 'bldg' | 'brid', lods: number[], preferNoTexture: boolean): Omit<TilesetChoice, 'level'> | null => {
    const cands = all.filter((d) => d.city === city && d.type_en === kind && lods.includes(d.lod));
    if (cands.length === 0) return null;
    const year = Math.max(...cands.map((d) => d.year));
    const ofYear = cands.filter((d) => d.year === year);
    for (const lod of lods) {
      const ofLod = ofYear.filter((d) => d.lod === lod).sort((a, b) => (a.url < b.url ? -1 : 1));
      const p = (preferNoTexture ? ofLod.find((d) => d.texture === false) : undefined) ?? ofLod[0];
      if (p) return { kind, city, lod, texture: p.texture === true, year, url: p.url };
    }
    return null;
  };
  for (const city of cities) {
    const d = pick(city, 'bldg', [2, 1], true);
    if (d) out.push({ level: 'detail', ...d });
    const b = pick(city, 'brid', [2, 1], true);
    if (b) out.push({ level: 'detail', ...b });
    const f = pick(city, 'bldg', [1], true);
    if (f) out.push({ level: 'far', ...f });
  }
  return out;
}

function intersects(a: RegionRad, r: number[]): boolean {
  const [w, s, e, n] = r as [number, number, number, number];
  return !(e < a.west || w > a.east || n < a.south || s > a.north);
}

interface ExtractedFeature {
  /** 割り当てたセル。 */
  cell: string;
  tris: Float32Array;
  id: string | null;
  /** 高さ（地心からの距離の幅, m）。 */
  heightM: number;
  /** 足元の中心の緯度経度（度）。 */
  lat: number;
  lon: number;
}

interface TileJob {
  url: string;
  choice: TilesetChoice;
}

function toLocal(X: number, Y: number, Z: number): { x: number; y: number; z: number } {
  const g = ecefToGeodetic({ x: X, y: Y, z: Z });
  return latLonToLocal({ lat: g.lat, lon: g.lon, alt: g.height - GEOID_HEIGHT_M });
}

/** 距離 d(m) の建物を遠景に入れる高さの下限。 */
function farMinHeight(d: number): number {
  for (const t of BAKE_PARAMS.farMinHeight) if (d <= t.withinM) return t.minHeightM;
  return Infinity;
}

interface ExtractContext {
  /** tall: 遠景の高い建物の LOD2 の形を取り出す（`tall` の gml_id だけ）。 */
  level: BuildingLevel | 'tall';
  tall?: Map<string, string>;
  detailCells: Set<string>;
  farChunks: Set<string>;
  points: Point[];
  /** LOD2 の地物（gml_id）を割り当てたセル。 */
  gmlCell: Map<string, string>;
}

/** タイルを復号し、範囲に入る地物の三角形をローカル座標で取り出す。 */
async function extractTile(job: TileJob, ctx: ExtractContext): Promise<{ features: ExtractedFeature[]; gml: [string, string][]; triangles: number }> {
  const tile = await fetchTile(job.url);
  const T = tile.triangles;
  const ids = tile.batchIds;
  const nTri = ids.length;
  const gmlIds = tile.batch['gml_id'] ?? [];
  // 地物ごとに三角形をまとめる（地物の番号の順、地物の中は元の順）
  let nF = 0;
  for (let t = 0; t < nTri; t++) nF = Math.max(nF, (ids[t] as number) + 1);
  const start = new Uint32Array(nF + 1);
  for (let t = 0; t < nTri; t++) {
    const id = (ids[t] as number) + 1;
    start[id] = (start[id] as number) + 1;
  }
  for (let f = 0; f < nF; f++) start[f + 1] = (start[f + 1] as number) + (start[f] as number);
  const fill = start.slice(0, nF);
  const order = new Uint32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const id = ids[t] as number;
    const at = fill[id] as number;
    order[at] = t;
    fill[id] = at + 1;
  }

  const { cellM, cellsPerFar, floorToleranceM } = BAKE_PARAMS;
  const farM = cellM * cellsPerFar;
  const features: ExtractedFeature[] = [];
  const gml: [string, string][] = [];
  let triangles = 0;
  for (let f = 0; f < nF; f++) {
    const a = start[f] as number;
    const b = start[f + 1] as number;
    if (a === b) continue;
    // 範囲と高さ（ECEF の箱と、地心からの距離の幅）
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let r0 = Infinity, r1 = -Infinity;
    for (let i = a; i < b; i++) {
      const t = order[i] as number;
      for (let k = 0; k < 3; k++) {
        const o = t * 9 + k * 3;
        const X = T[o] as number, Y = T[o + 1] as number, Z = T[o + 2] as number;
        if (X < x0) x0 = X; if (X > x1) x1 = X;
        if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
        const r = Math.hypot(X, Y, Z);
        if (r < r0) r0 = r; if (r > r1) r1 = r;
      }
    }
    const c = toLocal((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const own = cellKey(Math.floor(c.x / cellM), Math.floor(c.z / cellM));
    const id = typeof gmlIds[f] === 'string' ? (gmlIds[f] as string) : null;
    let cell = own;
    if (ctx.level === 'detail') {
      if (id && job.choice.kind === 'bldg') gml.push([id, own]);
      if (!ctx.detailCells.has(own)) continue;
    } else if (ctx.level === 'tall') {
      const t = id ? ctx.tall?.get(id) : undefined;
      if (t === undefined) continue;
      cell = t;
    } else {
      cell = (id && ctx.gmlCell.get(id)) || own;
      const [ci, cj] = parseKey(cell);
      if (!ctx.farChunks.has(cellKey(Math.floor((ci * cellM) / farM), Math.floor((cj * cellM) / farM)))) continue;
      let d = Infinity;
      for (const p of ctx.points) d = Math.min(d, Math.hypot(p.x - c.x, p.z - c.z));
      if (r1 - r0 < farMinHeight(d)) continue;
    }
    // 頂点をローカル座標へ
    const out = new Float32Array((b - a) * 9);
    let minY = Infinity;
    for (let i = a; i < b; i++) {
      const t = order[i] as number;
      for (let k = 0; k < 3; k++) {
        const o = t * 9 + k * 3;
        const l = toLocal(T[o] as number, T[o + 1] as number, T[o + 2] as number);
        const w = (i - a) * 9 + k * 3;
        out[w] = l.x;
        out[w + 1] = l.y;
        out[w + 2] = l.z;
        if (l.y < minY) minY = l.y;
      }
    }
    // 地面に接する下向きの面を捨てる
    let n = 0;
    for (let i = 0; i < b - a; i++) {
      const o = i * 9;
      const ax = out[o + 3]! - out[o]!, ay = out[o + 4]! - out[o + 1]!, az = out[o + 5]! - out[o + 2]!;
      const bx = out[o + 6]! - out[o]!, by = out[o + 7]! - out[o + 1]!, bz = out[o + 8]! - out[o + 2]!;
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz);
      const maxY = Math.max(out[o + 1]!, out[o + 4]!, out[o + 7]!);
      if (len > 0 && ny < -0.95 * len && maxY < minY + floorToleranceM) continue;
      if (n !== i) out.copyWithin(n * 9, o, o + 9);
      n++;
    }
    triangles += n;
    const ll = localToLatLon(c);
    features.push({ cell, tris: out.subarray(0, n * 9), id, heightM: r1 - r0, lat: ll.lat, lon: ll.lon });
  }
  return { features, gml, triangles };
}

/** 入力のハッシュ（変換のコード・設定・点）。 */
function inputHash(places: Place[]): string {
  const files = [
    'scripts/bake/buildings.ts',
    'scripts/bake/tiles.ts',
    'src/data/buildings.ts',
    'src/geo/ecef.ts',
    'src/geo/enu.ts',
    'src/config.ts',
  ];
  const parts = files.map((f) => `${f}:${sha256(readFileSync(join(ROOT, f)))}`);
  return sha256(JSON.stringify({ formatVersion: BUILDING_FORMAT_VERSION, params: BAKE_PARAMS, places, files: parts, catalog: CATALOG_URL }));
}

/** 出力がそろっていて、入力が同じか。 */
function upToDate(hash: string): boolean {
  const p = join(PUBLIC, BUILDING_MANIFEST_PATH);
  if (!existsSync(p)) return false;
  let m: BuildingManifest;
  try {
    m = JSON.parse(readFileSync(p, 'utf8')) as BuildingManifest;
  } catch {
    return false;
  }
  if (m.formatVersion !== BUILDING_FORMAT_VERSION || m.inputHash !== hash) return false;
  return m.chunks.every((c) => {
    const f = join(PUBLIC, c.path);
    if (!existsSync(f)) return false;
    const b = readFileSync(f);
    return b.byteLength === c.bytes && sha256(b) === c.sha256;
  });
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const force = process.argv.includes('--force');
  const places = placesFromScript();
  const hash = inputHash(places);
  if (!force && upToDate(hash)) {
    console.log(`[buildings] 出力は最新です（${BUILDING_MANIFEST_PATH}、inputHash ${hash.slice(0, 12)}）。作り直すときは --force`);
    return;
  }
  const { cellM, cellsPerFar, detailRadiusM, farRadiusM } = BAKE_PARAMS;
  const farM = cellM * cellsPerFar;
  const allPoints = places.flatMap((p) => p.points);

  // 範囲
  const detailCells = new Set<string>();
  const farChunks = new Set<string>();
  const placeDetail = places.map((p) => cellsNear(p.points, cellM, detailRadiusM));
  const placeFar = places.map((p) => cellsNear(p.points, farM, farRadiusM));
  for (const s of placeDetail) for (const k of s) detailCells.add(k);
  for (const s of placeFar) for (const k of s) farChunks.add(k);
  console.log(`[buildings] 場所 ${places.map((p) => `${p.name}（点 ${p.points.length}）`).join('、')}。詳細のセル ${detailCells.size}、遠景のチャンク ${farChunks.size}`);

  // タイルセットとタイル
  const catalog = await fetchJsonCached<{ datasets: CatalogEntry[] }>(CATALOG_URL);
  const choices = chooseTilesets(catalog.datasets);
  const regions: Record<BuildingLevel, RegionRad[]> = {
    detail: placeDetail.map((s) => regionOf(s, cellM)),
    far: placeFar.map((s) => regionOf(s, farM)),
  };
  const used: BuildingManifest['sources']['tilesets'] = [];
  const jobs: Record<BuildingLevel, TileJob[]> = { detail: [], far: [] };
  for (const choice of choices) {
    const ts = await fetchJsonCached<TilesetJson>(choice.url);
    const root = ts.root.boundingVolume.region;
    if (!root) throw new Error(`${choice.url} の root は region ではありません`);
    const urls = new Set<string>();
    for (const r of regions[choice.level]) {
      if (!intersects(r, root)) continue;
      for (const t of (await selectLeafTiles(choice.url, r)).tiles) urls.add(t.url);
    }
    if (urls.size === 0) continue;
    used.push({ level: choice.level, type: choice.kind, city: choice.city, lod: choice.lod, texture: choice.texture, year: choice.year, url: choice.url, leafTiles: urls.size });
    for (const url of urls) jobs[choice.level].push({ url, choice });
  }
  for (const l of ['detail', 'far'] as const) jobs[l].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  console.log(`[buildings] タイル 詳細 ${jobs.detail.length} 枚、遠景 ${jobs.far.length} 枚（${used.map((u) => `${u.city}/${u.type} LOD${u.lod}${u.level === 'far' ? '（遠景）' : ''}: ${u.leafTiles}`).join(', ')}）`);

  // 取り出し
  const gmlCell = new Map<string, string>();
  const extracted: Record<BuildingLevel | 'tall', ExtractedFeature[]> = { detail: [], far: [], tall: [] };
  const run = async (level: BuildingLevel | 'tall', list: TileJob[], tall?: Map<string, string>): Promise<void> => {
    const t1 = performance.now();
    const ctx: ExtractContext = { level, detailCells, farChunks, points: allPoints, gmlCell, tall };
    let done = 0;
    const results = await mapLimit(list, 8, async (job) => {
      const r = await extractTile(job, ctx);
      if (++done % 200 === 0) console.log(`[buildings] ${level} ${done}/${list.length}`);
      return r;
    });
    let tris = 0;
    for (const r of results) {
      // gml_id → セルは最初に現れたものを使う（タイルの境界で重複しても決まった値になる）
      for (const [id, cell] of r.gml) if (!gmlCell.has(id)) gmlCell.set(id, cell);
      extracted[level].push(...r.features);
      tris += r.triangles;
    }
    console.log(`[buildings] ${level}: タイル ${list.length} 枚、三角形 ${tris.toLocaleString()}（${((performance.now() - t1) / 1000).toFixed(1)} s）`);
  };
  await run('detail', jobs.detail);
  await run('far', jobs.far);

  // 遠景の高い建物: 同じ区の LOD2 のタイルセットから、足元の近くの葉のタイルだけを読んで形を置き換える
  const tallCell = new Map<string, string>();
  const tallUrls = new Map<string, TileJob>();
  const lod2ByCity = new Map(choices.filter((c) => c.level === 'detail' && c.kind === 'bldg' && c.lod === 2).map((c) => [c.city, c]));
  for (const f of extracted.far) {
    if (!f.id || f.heightM < BAKE_PARAMS.farLod2MinHeightM || tallCell.has(f.id)) continue;
    tallCell.set(f.id, f.cell);
  }
  const tallFeatures = extracted.far.filter((f) => f.id && tallCell.get(f.id) === f.cell && f.heightM >= BAKE_PARAMS.farLod2MinHeightM);
  const r = Math.PI / 180;
  const pad = 0.0008;
  for (const choice of lod2ByCity.values()) {
    const ts = await fetchJsonCached<TilesetJson>(choice.url);
    const root = ts.root.boundingVolume.region as number[];
    for (const f of tallFeatures) {
      const area: RegionRad = { west: (f.lon - pad) * r, east: (f.lon + pad) * r, south: (f.lat - pad) * r, north: (f.lat + pad) * r };
      if (!intersects(area, root)) continue;
      for (const t of (await selectLeafTiles(choice.url, area)).tiles) if (!tallUrls.has(t.url)) tallUrls.set(t.url, { url: t.url, choice });
    }
  }
  const tallJobs = [...tallUrls.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  await run('tall', tallJobs, tallCell);
  const tallShape = new Map<string, ExtractedFeature>();
  for (const f of extracted.tall) if (f.id && !tallShape.has(f.id)) tallShape.set(f.id, f);
  console.log(`[buildings] 遠景の高い建物（${BAKE_PARAMS.farLod2MinHeightM}m 以上）${tallCell.size} 棟のうち ${tallShape.size} 棟を LOD2 の形にした`);

  const byCell: Record<BuildingLevel, Map<string, { tris: Float32Array[]; features: number }>> = { detail: new Map(), far: new Map() };
  for (const level of ['detail', 'far'] as const) {
    for (const f0 of extracted[level]) {
      const f = level === 'far' && f0.id ? (tallShape.get(f0.id) ?? f0) : f0;
      let e = byCell[level].get(f0.cell);
      if (!e) byCell[level].set(f0.cell, (e = { tris: [], features: 0 }));
      e.tris.push(f.tris);
      e.features++;
    }
  }

  // 書き出し
  const chunks: BuildingChunkInfo[] = [];
  const write = (level: BuildingLevel, ix: number, iz: number, groups: Float32Array[][], features: number, minStep: number): void => {
    const mesh = quantizeTriangles(
      groups.map((g) => {
        let n = 0;
        for (const a of g) n += a.length;
        const out = new Float32Array(n);
        let o = 0;
        for (const a of g) {
          out.set(a, o);
          o += a.length;
        }
        return out;
      }),
      minStep,
    );
    if (mesh.indices.length === 0) return;
    const raw = encodeBuildingChunk(mesh);
    const gz = new Uint8Array(gzipSync(raw, { level: 9 }));
    const path = buildingChunkPath(level, ix, iz);
    const file = join(PUBLIC, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, gz);
    let minQ = 65535;
    let maxQ = 0;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      const v = mesh.positions[i] as number;
      if (v < minQ) minQ = v;
      if (v > maxQ) maxQ = v;
    }
    chunks.push({
      level,
      ix,
      iz,
      path,
      bytes: gz.byteLength,
      rawBytes: raw.byteLength,
      sha256: sha256(gz),
      triangles: mesh.indices.length / 3,
      vertices: mesh.positions.length / 3,
      features,
      minY: round(mesh.origin[1] + minQ * mesh.step[1], 2),
      maxY: round(mesh.origin[1] + maxQ * mesh.step[1], 2),
    });
  };
  for (const k of sortKeys(detailCells)) {
    const e = byCell.detail.get(k);
    if (!e) continue;
    const [i, j] = parseKey(k);
    write('detail', i, j, [e.tris], e.features, BAKE_PARAMS.detailStepM);
  }
  for (const k of sortKeys(farChunks)) {
    const [fi, fj] = parseKey(k);
    const groups: Float32Array[][] = [];
    let features = 0;
    for (let sj = 0; sj < cellsPerFar; sj++) {
      for (let si = 0; si < cellsPerFar; si++) {
        const e = byCell.far.get(cellKey(fi * cellsPerFar + si, fj * cellsPerFar + sj));
        groups.push(e?.tris ?? []);
        features += e?.features ?? 0;
      }
    }
    write('far', fi, fj, groups, features, BAKE_PARAMS.farStepM);
  }

  // 古いファイルを消す
  const keep = new Set(chunks.map((c) => join(PUBLIC, c.path)));
  for (const level of ['detail', 'far'] as const) {
    const dir = join(OUT_DIR, level);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (!keep.has(join(dir, f))) rmSync(join(dir, f));
  }

  // メタ情報
  const sum = (cs: BuildingChunkInfo[]) => ({
    files: cs.length,
    bytes: cs.reduce((a, c) => a + c.bytes, 0),
    rawBytes: cs.reduce((a, c) => a + c.rawBytes, 0),
    triangles: cs.reduce((a, c) => a + c.triangles, 0),
  });
  const byKey = new Map(chunks.map((c) => [`${c.level}:${c.ix}_${c.iz}`, c]));
  const placeInfo: BuildingPlaceInfo[] = places.map((p, i) => {
    const pick = (level: BuildingLevel, keys: Set<string>): BuildingChunkInfo[] =>
      [...keys].map((k) => byKey.get(`${level}:${k}`)).filter((c): c is BuildingChunkInfo => c !== undefined);
    const d = pick('detail', placeDetail[i] as Set<string>);
    const f = pick('far', placeFar[i] as Set<string>);
    return {
      name: p.name,
      label: p.label,
      points: p.points.map((q) => {
        const ll = localToLatLon({ x: q.x, y: 0, z: q.z });
        return { ...q, lat: round(ll.lat, 6), lon: round(ll.lon, 6) };
      }),
      radiusM: { detail: detailRadiusM, far: farRadiusM },
      chunks: { detail: d.length, far: f.length },
      bytes: { detail: sum(d).bytes, far: sum(f).bytes },
    };
  });
  const manifestPath = join(PUBLIC, BUILDING_MANIFEST_PATH);
  const today = new Date().toISOString().slice(0, 10);
  let generatedAt = today;
  if (existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildingManifest;
      const same = prev.chunks.length === chunks.length && prev.chunks.every((c, i) => c.sha256 === chunks[i]?.sha256 && c.path === chunks[i]?.path);
      if (same && typeof prev.generatedAt === 'string') generatedAt = prev.generatedAt;
    } catch {
      // 読めなければ今日の日付
    }
  }
  const detailChunks = chunks.filter((c) => c.level === 'detail');
  const farChunkInfo = chunks.filter((c) => c.level === 'far');
  const manifest: BuildingManifest = {
    formatVersion: BUILDING_FORMAT_VERSION,
    inputHash: hash,
    generatedAt,
    coordinates:
      'CLAUDE.md の座標規約（平らな地図）。X=東, Y=標高(m, 東京湾平均海面), Z=南, 1単位=1m, 原点 ' +
      `${ORIGIN.lat}, ${ORIGIN.lon}。頂点ごとに ECEF → 緯度経度・楕円体高 → latLonToLocal（高さ = 楕円体高 − GEOID_HEIGHT_M ${GEOID_HEIGHT_M}m）。`,
    levels: {
      detail: {
        chunkSizeM: cellM,
        cellsPerSide: 1,
        viewDistanceM: DETAIL_VIEW_M,
        description: 'LOD2（テクスチャなし）の建物と、橋梁・高架（LOD2、なければ LOD1）。形はそのまま（地面に接する床の面を除く）。',
      },
      far: {
        chunkSizeM: farM,
        cellsPerSide: cellsPerFar,
        viewDistanceM: farRadiusM,
        description: `LOD1（箱）の建物のうち、最も近い点からの距離ごとの高さ以上のもの（${BAKE_PARAMS.farMinHeight.map((t) => `${Number.isFinite(t.withinM) ? `${t.withinM}m 以内` : 'それより遠く'} ${t.minHeightM}m 以上`).join('、')}）。床の面を除く。`,
      },
    },
    places: placeInfo,
    sources: {
      catalog: CATALOG_URL,
      tilesets: used,
      method:
        '葉のタイル（最も細かい詳細度）を復号し、地物（建物・橋梁）ごとに頂点の範囲の中心でセルに割り当てた。' +
        `遠景の高さ ${BAKE_PARAMS.farLod2MinHeightM}m 以上の建物は、同じ gml_id の LOD2 の形に置き換えた。` +
        '位置は刻み（詳細 1cm・遠景 5cm 以上）で 16bit に量子化し、同じ位置の頂点をまとめた。属性情報・テクスチャ・法線は持たない。',
    },
    totals: { ...sum(chunks), byLevel: { detail: sum(detailChunks), far: sum(farChunkInfo) } },
    chunks,
    detailCells: sortKeys(detailCells),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const mb = (b: number): string => (b / 1e6).toFixed(2);
  for (const p of placeInfo) console.log(`[buildings] ${p.name}: 詳細 ${p.chunks.detail} 個 ${mb(p.bytes.detail)} MB、遠景 ${p.chunks.far} 個 ${mb(p.bytes.far)} MB`);
  const t = manifest.totals;
  const fc = fetchCounts();
  console.log(
    `[buildings] 合計 ${t.files} ファイル ${mb(t.bytes)} MB（gzip 前 ${mb(t.rawBytes)} MB）三角形 ${t.triangles.toLocaleString()}` +
      `（詳細 ${mb(t.byLevel.detail.bytes)} MB、遠景 ${mb(t.byLevel.far.bytes)} MB）` +
      ` ${((performance.now() - t0) / 1000).toFixed(1)} s（ネットワーク ${fc.network} 件、キャッシュ ${fc.cache} 件）`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
