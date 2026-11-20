/**
 * PLATEAU の 3D Tiles と国土地理院の標高タイルから「街の高さ格子」を焼き込む。
 *
 * 実行: npm run data:grids
 *   （= node --import ./scripts/bake/register.ts scripts/bake/index.ts [地区名...]）
 * 出力: public/data/grids/<名前>.{json,height.bin,ground.bin,class.bin}
 * 取得したファイルは node_modules/.cache/ptm-bake/ にキャッシュする（2回目以降はネットワークに出ない）。
 *
 * 方式: Node でタイル（b3dm, Draco 圧縮）を取得・復号し、CPU で三角形を格子に投影する。
 * 各セルの中心を真上から見て、覆う三角形の高さ（重心座標で補間）の最大を屋上とする。
 * 地面は国土地理院の 5m メッシュ標高（dem5a）。無効値（主に水面）は近傍の最も低い地面で埋め、分類 255 にする。
 *
 * 座標は CLAUDE.md の座標規約（平らな地図）に従う: ローカル Y = 標高(m)、水平は latLonToLocal。
 * 3D Tiles（ECEF・楕円体高）はタイルごとに置き直す（{@link tileToLocal}。街並みの表示と同じ方法）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEOID_HEIGHT_M, ORIGIN } from '../../src/config';
import {
  GRID_CLASS,
  gridMetaPath,
  quantizeHeights,
  uint16ToBytes,
  type GridFileInfo,
  type GridMeta,
} from '../../src/data/grids';
import { enuBasis } from '../../src/geo/ecef';
import { ecefToGeodetic, latLonToLocal, localToLatLon } from '../../src/geo/enu';
import { fillMissingHeights, type HeightGrid } from '../../src/sim/heightGrid';
import { fetchCounts, fetchJsonCached, mapLimit } from './cache';
import { DEM_SOURCES, DemLayer } from './dem';
import { CANDIDATE_CITIES, DISTRICTS, type District } from './districts';
import { fetchTile, selectLeafTiles, type RegionRad, type TilesetJson } from './tiles';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = join(ROOT, 'public/data/grids');
const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
/** 高さの量子化の刻み(m)。 */
const QUANT_STEP = 0.02;

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
  kind: 'bldg' | 'brid';
  city: string;
  lod: number;
  texture: boolean;
  year: number;
  url: string;
}

/** 区ごとに使うタイルセットを選ぶ。建物は LOD2（テクスチャなし優先）、なければ LOD1。橋梁も LOD2、なければ LOD1。 */
function chooseTilesets(catalog: CatalogEntry[]): TilesetChoice[] {
  const out: TilesetChoice[] = [];
  for (const city of CANDIDATE_CITIES) {
    for (const kind of ['bldg', 'brid'] as const) {
      const cands = catalog
        .filter((d) => d.pref === '東京都' && d.city === city && d.type_en === kind && d.format === '3D Tiles')
        .map((d) => ({ ...d, lod: Number(d.lod), year: Number(d.year) }))
        .filter((d) => d.lod === 1 || d.lod === 2);
      if (cands.length === 0) continue;
      const year = Math.max(...cands.map((d) => d.year));
      const ofYear = cands.filter((d) => d.year === year);
      const lod = ofYear.some((d) => d.lod === 2) ? 2 : 1;
      const ofLod = ofYear.filter((d) => d.lod === lod);
      const pick = ofLod.find((d) => d.texture === false) ?? ofLod[0];
      if (!pick) continue;
      out.push({ kind, city, lod, texture: pick.texture === true, year, url: pick.url });
    }
  }
  return out;
}

interface Feature {
  kind: 'bldg' | 'brid';
  gmlId: string;
  name: string | null;
  measuredHeight: number | null;
  zmin: number | null;
  lod: number | null;
  /** 頂点の最小のローカル Y。 */
  baseY: number;
  /** 最小のローカル Y の頂点の楕円体高。 */
  baseEllipsoidal: number;
  baseLat: number;
  baseLon: number;
  /** 頂点の最大のローカル Y。 */
  topY: number;
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i] as number;
};
const round = (v: number, d = 3): number => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function bakeDistrict(d: District, tilesets: TilesetChoice[]): Promise<void> {
  const t0 = performance.now();
  const W = Math.round(d.size / d.cellSize);
  const H = W;
  const cs = d.cellSize;
  const c = latLonToLocal({ lat: d.lat, lon: d.lon });
  const originX = Math.round(c.x - (W * cs) / 2);
  const originZ = Math.round(c.z - (H * cs) / 2);

  // 範囲（緯度経度）
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const [x, z] of [
    [originX, originZ],
    [originX + W * cs, originZ],
    [originX, originZ + H * cs],
    [originX + W * cs, originZ + H * cs],
  ] as const) {
    const p = localToLatLon({ x, y: 0, z });
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  }
  const rad = Math.PI / 180;
  const area: RegionRad = { west: west * rad, south: south * rad, east: east * rad, north: north * rad };

  // タイルの選択
  const used: { choice: TilesetChoice; tiles: number; maxDepth: number; geometricErrors: number[] }[] = [];
  const tileJobs: { url: string; kind: 'bldg' | 'brid' }[] = [];
  for (const ts of tilesets) {
    const root = (await fetchJsonCached<TilesetJson>(ts.url)).root.boundingVolume.region as number[];
    const [rw, rs, re, rn] = root as [number, number, number, number];
    if (re < area.west || rw > area.east || rn < area.south || rs > area.north) continue;
    const sel = await selectLeafTiles(ts.url, area);
    if (sel.tiles.length === 0) continue;
    used.push({
      choice: ts,
      tiles: sel.tiles.length,
      maxDepth: sel.maxDepth,
      geometricErrors: [...new Set(sel.tiles.map((t) => t.geometricError))].sort((a, b) => a - b),
    });
    for (const t of sel.tiles) tileJobs.push({ url: t.url, kind: ts.kind });
  }
  tileJobs.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  console.log(`[${d.name}] タイル ${tileJobs.length} 枚（${used.map((u) => `${u.choice.city}/${u.choice.kind} LOD${u.choice.lod}: ${u.tiles}`).join(', ')}）`);

  // 取得（並列）→ 格子に投影（入力の順に逐次。結果は順序に依存しない max だが、所有者の決定を安定させる）
  const n = W * H;
  const top = new Float32Array(n).fill(-Infinity);
  const topKind = new Uint8Array(n); // 0=なし 1=建物 2=橋梁
  const owner = new Int32Array(n).fill(-1);
  const features: Feature[] = [];
  const featureIndex = new Map<string, number>();
  let triangles = 0;
  const extSeen = new Set<string>();

  const decoded = await mapLimit(tileJobs, 12, async (job) => ({ job, tile: await fetchTile(job.url) }));
  for (const { job, tile } of decoded) {
    tile.extensions.forEach((e) => extSeen.add(e));
    const gml = tile.batch['gml_id'] ?? [];
    const names = tile.batch['gml:name'] ?? [];
    const mh = tile.batch['bldg:measuredHeight'] ?? [];
    const zmin = tile.batch['_zmin'] ?? [];
    const lod = tile.batch['_lod'] ?? [];
    const localIds = new Int32Array(Math.max(1, tile.batchLength)).fill(-1);
    const fid = (b: number): number => {
      const cached = localIds[b] as number;
      if (cached >= 0) return cached;
      const id = String(gml[b] ?? `${job.url}#${b}`);
      let k = featureIndex.get(id);
      if (k === undefined) {
        k = features.length;
        featureIndex.set(id, k);
        const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        features.push({
          kind: job.kind,
          gmlId: id,
          name: typeof names[b] === 'string' ? (names[b] as string) : null,
          measuredHeight: num(mh[b]),
          zmin: num(zmin[b]),
          lod: num(lod[b]),
          baseY: Infinity,
          baseEllipsoidal: Number.NaN,
          baseLat: Number.NaN,
          baseLon: Number.NaN,
          topY: -Infinity,
        });
      }
      localIds[b] = k;
      return k;
    };
    const T = tile.triangles;
    const nTri = T.length / 9;
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11] = tileToLocal(T);
    triangles += nTri;
    const lx = new Float64Array(3);
    const ly = new Float64Array(3);
    const lz = new Float64Array(3);
    for (let t = 0; t < nTri; t++) {
      const f = fid(tile.batchIds[t] as number);
      const feat = features[f] as Feature;
      for (let k = 0; k < 3; k++) {
        const X = T[t * 9 + k * 3] as number;
        const Y = T[t * 9 + k * 3 + 1] as number;
        const Z = T[t * 9 + k * 3 + 2] as number;
        const x = m0 * X + m1 * Y + m2 * Z + m3;
        const y = m4 * X + m5 * Y + m6 * Z + m7;
        const z = m8 * X + m9 * Y + m10 * Z + m11;
        lx[k] = x;
        ly[k] = y;
        lz[k] = z;
        if (y < feat.baseY) {
          feat.baseY = y;
          const g = ecefToGeodetic([X, Y, Z]);
          feat.baseEllipsoidal = g.alt;
          feat.baseLat = g.lat;
          feat.baseLon = g.lon;
        }
        if (y > feat.topY) feat.topY = y;
      }
      rasterTriangle(lx, ly, lz, originX, originZ, cs, W, H, (cell, y) => {
        if (y > (top[cell] as number)) {
          top[cell] = y;
          owner[cell] = f;
          topKind[cell] = job.kind === 'bldg' ? 1 : 2;
        }
      });
    }
  }

  // 地面: 標高タイル + ジオイド高
  const layers = DEM_SOURCES.map((s) => new DemLayer(s));
  for (const l of layers) await l.prefetch(south, west, north, east);
  const ground = new Float32Array(n);
  const demUsed = new Array<number>(layers.length + 1).fill(0);
  for (let r = 0; r < H; r++) {
    for (let col = 0; col < W; col++) {
      const x = originX + (col + 0.5) * cs;
      const z = originZ + (r + 0.5) * cs;
      // ローカル Y は標高そのもの（平らな地図）。
      const p = localToLatLon({ x, y: 0, z });
      let hOrtho = Number.NaN;
      let src = layers.length;
      for (let li = 0; li < layers.length; li++) {
        const v = (layers[li] as DemLayer).sample(p.lat, p.lon);
        if (!Number.isNaN(v)) {
          hOrtho = v;
          src = li;
          break;
        }
      }
      demUsed[src] = (demUsed[src] as number) + 1;
      ground[r * W + col] = Number.isNaN(hOrtho) ? Number.NaN : hOrtho - (ORIGIN.alt ?? 0);
    }
  }
  const missingGround = demUsed[layers.length] as number;
  const groundGrid: HeightGrid = { width: W, height: H, cellSize: cs, originX, originZ, data: ground };
  const groundFilled = missingGround > 0 ? fillMissingHeights(groundGrid).data : ground;

  // 分類と地表
  const classes = new Uint8Array(n);
  const surface = new Float32Array(n);
  const counts = { ground: 0, building: 0, bridge: 0, nodata: 0 };
  for (let i = 0; i < n; i++) {
    const g = groundFilled[i] as number;
    if (topKind[i] === 1 || topKind[i] === 2) {
      classes[i] = topKind[i] === 1 ? GRID_CLASS.building : GRID_CLASS.bridge;
      surface[i] = Math.max(top[i] as number, g);
      if (topKind[i] === 1) counts.building++;
      else counts.bridge++;
    } else if (Number.isNaN(ground[i] as number)) {
      classes[i] = GRID_CLASS.nodata;
      surface[i] = g;
      counts.nodata++;
    } else {
      classes[i] = GRID_CLASS.ground;
      surface[i] = g;
      counts.ground++;
    }
  }

  // 建物の足元と地面の比較（地物ごと: 頂点の最小のローカル Y − 足元のセルの地面の中央値）
  const cellsOf = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const f = owner[i] as number;
    if (f < 0) continue;
    let a = cellsOf.get(f);
    if (!a) cellsOf.set(f, (a = []));
    a.push(i);
  }
  const baseDiffs: number[] = [];
  const baseDiffsLow: number[] = [];
  const geoidUsed: number[] = [];
  for (const [f, cells] of cellsOf) {
    const feat = features[f] as Feature;
    if (feat.kind !== 'bldg') continue;
    if (feat.zmin !== null && Number.isFinite(feat.baseEllipsoidal)) geoidUsed.push(feat.baseEllipsoidal - feat.zmin);
    if (cells.length < 20) continue;
    const gs = cells.map((i) => groundFilled[i] as number).sort((a, b) => a - b);
    baseDiffs.push(feat.baseY - percentile(gs, 0.5));
    baseDiffsLow.push(feat.baseY - percentile(gs, 0.05));
  }
  baseDiffs.sort((a, b) => a - b);
  baseDiffsLow.sort((a, b) => a - b);
  geoidUsed.sort((a, b) => a - b);

  // 既知の建物との照合
  const landmarks = d.landmarks.flatMap((lm) => {
    const p = latLonToLocal({ lat: lm.lat, lon: lm.lon });
    const col = Math.floor((p.x - originX) / cs);
    const row = Math.floor((p.z - originZ) / cs);
    if (col < 0 || row < 0 || col >= W || row >= H) return [];
    let byName = features.findIndex((f, i) => f.name === lm.name && cellsOf.has(i));
    if (byName < 0) byName = features.findIndex((f, i) => f.name !== null && f.name.includes(lm.name) && cellsOf.has(i));
    const f = byName >= 0 ? byName : (owner[row * W + col] as number);
    if (f < 0) return [{ query: lm.name, found: false }];
    const feat = features[f] as Feature;
    const cells = cellsOf.get(f) ?? [];
    let roof = -Infinity;
    for (const i of cells) roof = Math.max(roof, top[i] as number);
    // 周囲の地面: 足元のセルの地面（DEM）の中央値
    const gs = cells.map((i) => groundFilled[i] as number).sort((a, b) => a - b);
    const g = percentile(gs, 0.5);
    return [{
      query: lm.name,
      found: true,
      matchedBy: byName >= 0 ? 'name' : 'point',
      gmlId: feat.gmlId,
      name: feat.name,
      lod: feat.lod,
      footprintCells: cells.length,
      roofY: round(roof, 2),
      groundY: round(g, 2),
      gridHeight: round(roof - g, 2),
      measuredHeight: feat.measuredHeight,
      modelHeight: round(feat.topY - feat.baseY, 2),
    }];
  });

  // 量子化と書き出し
  const hq = quantizeHeights(surface, QUANT_STEP);
  const gq = quantizeHeights(groundFilled, QUANT_STEP);
  const files = {
    height: uint16ToBytes(hq.data),
    ground: uint16ToBytes(gq.data),
    class: classes,
  };
  const info = (suffix: string, b: Uint8Array): GridFileInfo => ({
    path: `data/grids/${d.name}.${suffix}.bin`,
    bytes: b.byteLength,
    sha256: sha256(b),
  });
  const fileInfo = { height: info('height', files.height), ground: info('ground', files.ground), class: info('class', files.class) };

  const metaPath = join(ROOT, 'public', gridMetaPath(d.name));
  const today = new Date().toISOString().slice(0, 10);
  let generatedAt = today;
  if (existsSync(metaPath)) {
    // 中身が変わらなければ生成日を据え置く（再実行で出力が変わらないように）。
    const prev = JSON.parse(readFileSync(metaPath, 'utf8')) as GridMeta;
    const same = (['height', 'ground', 'class'] as const).every((k) => prev.files?.[k]?.sha256 === fileInfo[k].sha256);
    if (same && typeof prev.generatedAt === 'string') generatedAt = prev.generatedAt;
  }
  let hMin = Infinity;
  let hMax = -Infinity;
  let gMin = Infinity;
  let gMax = -Infinity;
  for (let i = 0; i < n; i++) {
    hMin = Math.min(hMin, surface[i] as number);
    hMax = Math.max(hMax, surface[i] as number);
    gMin = Math.min(gMin, groundFilled[i] as number);
    gMax = Math.max(gMax, groundFilled[i] as number);
  }
  const groundSorted = Array.from(groundFilled).sort((a, b) => a - b);
  const meta: GridMeta = {
    formatVersion: 1,
    name: d.name,
    width: W,
    height: H,
    cellSize: cs,
    originX,
    originZ,
    center: { lat: d.lat, lon: d.lon },
    heightReference: {
      description:
        'ローカル Y(m) = 標高（東京湾平均海面基準）。CLAUDE.md の座標規約（平らな地図）に従う。' +
        '建物・橋梁は PLATEAU の 3D Tiles（ECEF・楕円体高）を、街並みの表示と同じくタイルごとに置き直した: タイルの中心（ECEF の軸平行の箱の中心）を ' +
        'latLonToLocal（高さ = 楕円体高 − GEOID_HEIGHT_M）の位置へ、その地点の東・上・南を X・Y・Z に合わせる剛体変換。' +
        '地面は国土地理院 5m メッシュ標高（dem5a）をそのまま Y にした。水平はセルの中心を localToLatLon で緯度経度にして標本化した。',
      origin: { lat: ORIGIN.lat, lon: ORIGIN.lon, alt: ORIGIN.alt },
      tilesHeight: 'ellipsoidal',
      geoidHeightM: GEOID_HEIGHT_M,
    },
    quantization: { height: hq.q, ground: gq.q },
    classes: { ...GRID_CLASS },
    files: fileInfo,
    sources: {
      tilesets: used.map((u) => ({
        type: u.choice.kind,
        city: u.choice.city,
        lod: u.choice.lod,
        texture: u.choice.texture,
        year: u.choice.year,
        url: u.choice.url,
        leafTiles: u.tiles,
        leafGeometricErrors: u.geometricErrors,
      })),
      catalog: CATALOG_URL,
      dem: layers.map((l, i) => ({ id: l.source.id, url: l.source.url, zoom: l.source.zoom, description: l.source.description, cells: demUsed[i] })),
      method:
        '葉のタイル（最も細かい詳細度）の三角形を真上から投影し、セルの中心を覆う三角形の高さの最大を屋上とした。' +
        '地面は標高タイルを双一次補間（dem5a の欠けは dem5b で補う）。どちらも無効値のセル（主に水面: お濠・川）は fillMissingHeights で近傍の最も低い地面の値で埋め、建物・橋梁がなければ分類 255 とした。',
    },
    generatedAt,
    stats: {
      classes: counts,
      classFractions: {
        ground: round(counts.ground / n, 4),
        building: round(counts.building / n, 4),
        bridge: round(counts.bridge / n, 4),
        nodata: round(counts.nodata / n, 4),
      },
      surfaceY: { min: round(hMin, 2), max: round(hMax, 2) },
      groundY: { min: round(gMin, 2), median: round(percentile(groundSorted, 0.5), 2), max: round(gMax, 2) },
      triangles,
      features: features.length,
      buildingBaseMinusGround: {
        description: '建物の頂点の最小のローカル Y − 足元のセルの地面（標高タイル）の中央値(m)。足元が 20 セル以上の建物。',
        count: baseDiffs.length,
        p10: round(percentile(baseDiffs, 0.1), 2),
        median: round(percentile(baseDiffs, 0.5), 2),
        p90: round(percentile(baseDiffs, 0.9), 2),
        medianAbs: round(percentile(baseDiffs.map(Math.abs).sort((a, b) => a - b), 0.5), 2),
        versusLowGround: {
          description: '足元のセルの地面の 5 パーセンタイル（足元の低い側）との差(m)。',
          p10: round(percentile(baseDiffsLow, 0.1), 2),
          median: round(percentile(baseDiffsLow, 0.5), 2),
          p90: round(percentile(baseDiffsLow, 0.9), 2),
        },
      },
      plateauGeoidEstimate: {
        description: '建物の最下部の頂点の楕円体高 − 属性 _zmin（標高）の中央値(m)。PLATEAU の変換に使われたジオイド高の推定（格子では定数 GEOID_HEIGHT_M を引いている）。',
        count: geoidUsed.length,
        median: round(percentile(geoidUsed, 0.5), 3),
        p10: round(percentile(geoidUsed, 0.1), 3),
        p90: round(percentile(geoidUsed, 0.9), 3),
      },
      tallest: [...cellsOf.keys()]
        .map((f) => features[f] as Feature)
        .sort((a, b) => b.topY - a.topY || (a.gmlId < b.gmlId ? -1 : 1))
        .slice(0, 8)
        .map((f) => ({ kind: f.kind, name: f.name, gmlId: f.gmlId, topY: round(f.topY, 2), modelHeight: round(f.topY - f.baseY, 2), measuredHeight: f.measuredHeight })),
      gltfExtensions: [...extSeen].sort(),
    },
    landmarks,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${d.name}.height.bin`), files.height);
  writeFileSync(join(OUT_DIR, `${d.name}.ground.bin`), files.ground);
  writeFileSync(join(OUT_DIR, `${d.name}.class.bin`), files.class);
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(
    `[${d.name}] ${W}x${H} 三角形 ${triangles.toLocaleString()} 地物 ${features.length} ` +
      `建物 ${(counts.building / n * 100).toFixed(1)}% 橋梁 ${(counts.bridge / n * 100).toFixed(1)}% データなし ${counts.nodata} ` +
      `地面 Y ${gMin.toFixed(2)}〜${gMax.toFixed(2)} 足元−地面 中央値 ${percentile(baseDiffs, 0.5).toFixed(2)} m ` +
      `(${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  );
}

/**
 * タイルの ECEF → ローカルの剛体変換（行優先 3x4）。街並みの表示（src/scene/plateau/buildings.ts）と同じく、
 * タイルの中心（頂点の軸平行の箱の中心）c を latLonToLocal（高さ = 楕円体高 − GEOID_HEIGHT_M）の位置へ写し、
 * c での東・上・南をローカルの +X・+Y・+Z に向ける。
 */
type Mat3x4 = [number, number, number, number, number, number, number, number, number, number, number, number];

export function tileToLocal(T: Float64Array): Mat3x4 {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < T.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = T[i + k] as number;
      if (v < (lo[k] as number)) lo[k] = v;
      if (v > (hi[k] as number)) hi[k] = v;
    }
  }
  const c = [0, 1, 2].map((k) => ((lo[k] as number) + (hi[k] as number)) / 2) as [number, number, number];
  const g = ecefToGeodetic(c);
  const l = latLonToLocal({ lat: g.lat, lon: g.lon, alt: g.alt - GEOID_HEIGHT_M });
  const { east: e, north: nn, up: u } = enuBasis(g.lat, g.lon);
  const dot = (a: { x: number; y: number; z: number }): number => a.x * c[0] + a.y * c[1] + a.z * c[2];
  return [
    e.x, e.y, e.z, l.x - dot(e),
    u.x, u.y, u.z, l.y - dot(u),
    -nn.x, -nn.y, -nn.z, l.z + dot(nn),
  ];
}

/**
 * 三角形 (x, y, z)×3 を格子に投影し、中心が三角形の内側（辺上を含む）にあるセルごとに
 * 補間した y で visit(cell, y) を呼ぶ。真上から見て面積のない三角形（壁）は飛ばす。
 */
export function rasterTriangle(
  x: Float64Array,
  y: Float64Array,
  z: Float64Array,
  originX: number,
  originZ: number,
  cs: number,
  W: number,
  H: number,
  visit: (cell: number, y: number) => void,
): void {
  const ax = x[0] as number, az = z[0] as number;
  const bx = x[1] as number, bz = z[1] as number;
  const cx = x[2] as number, cz = z[2] as number;
  const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minZ = Math.min(az, bz, cz);
  const maxZ = Math.max(az, bz, cz);
  const c0 = Math.max(0, Math.ceil((minX - originX) / cs - 0.5));
  const c1 = Math.min(W - 1, Math.floor((maxX - originX) / cs - 0.5));
  const r0 = Math.max(0, Math.ceil((minZ - originZ) / cs - 0.5));
  const r1 = Math.min(H - 1, Math.floor((maxZ - originZ) / cs - 0.5));
  if (c0 > c1 || r0 > r1) return;
  const inv = 1 / area;
  const ay = y[0] as number, by = y[1] as number, cy = y[2] as number;
  const eps = -1e-9;
  for (let r = r0; r <= r1; r++) {
    const pz = originZ + (r + 0.5) * cs;
    for (let col = c0; col <= c1; col++) {
      const px = originX + (col + 0.5) * cs;
      const w0 = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) * inv;
      const w1 = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      visit(r * W + col, w0 * ay + w1 * by + w2 * cy);
    }
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const only = process.argv.slice(2);
  const catalog = await fetchJsonCached<{ datasets: CatalogEntry[] }>(CATALOG_URL);
  const tilesets = chooseTilesets(catalog.datasets);
  for (const d of DISTRICTS) {
    if (only.length > 0 && !only.includes(d.name)) continue;
    await bakeDistrict(d, tilesets);
  }
  const fc = fetchCounts();
  console.log(`完了 ${((performance.now() - t0) / 1000).toFixed(1)} s（ネットワーク ${fc.network} 件、キャッシュ ${fc.cache} 件）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
