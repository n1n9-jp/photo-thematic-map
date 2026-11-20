/**
 * 東京都「駅前放置自転車等の現況と対策」の一次資料から、作品用の JSON を作る。
 *
 * 実行: npm run data:bicycles（= node scripts/data/build-bicycles.ts）
 * 入力: data/raw/bicycles/（取得元は data/raw/bicycles/SOURCES.md）
 * 出力: public/data/bicycles/{stations,municipalities,timeseries,summary}.json
 *
 * 公表値との照合に失敗した場合は例外を投げて終了コード 1 で止まる。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = join(ROOT, 'data/raw/bicycles');
const OUT = join(ROOT, 'public/data/bicycles');

// ---------------------------------------------------------------------------
// 出典
// ---------------------------------------------------------------------------
const SRC = {
  excel: {
    document: '駅前放置自転車等の現況と対策 －令和７年度調査－ （4）駅別放置自転車、原動機付自転車及び自動二輪車の状況（Excel）',
    url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07ekibetsuhouchi',
    file: 'data/raw/bicycles/07ekibetsuhouchi.xlsx',
  },
  report: {
    document: '駅前放置自転車等の現況と対策 －令和７年度調査－（全文）',
    url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202603_jitensyagenkyo',
  },
  gaiyou: {
    document: '「駅前放置自転車等の現況と対策－令和７年度調査－」について －調査結果の概要－',
    url: 'https://www.metro.tokyo.lg.jp/documents/d/tosei/20260326_24_03a',
  },
  press: {
    document: '東京都 報道発表「駅前放置自転車等の現況と対策」調査結果（2026年3月26日）',
    url: 'https://www.metro.tokyo.lg.jp/information/press/2026/03/2026032616',
  },
  n02: {
    document: '国土数値情報 鉄道データ（N02、2024年度）駅',
    url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html',
    license: 'CC BY 4.0（出典：国土交通省 国土数値情報（鉄道データ）を加工して作成）',
  },
} as const;

/** 過去年度の全文 PDF（撤去台数の推移に使う）。fiscalYear は撤去の年度、report は調査年度。 */
const REMOVAL_REPORTS: { fiscalYear: number; report: string; url: string; page: string; file: string }[] = [
  { fiscalYear: 2010, report: '平成23年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo2', page: 'PDF物理ページ48', file: 'removal_FY2010_report-H23_phys048.txt' },
  { fiscalYear: 2011, report: '平成24年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo242', page: 'PDF物理ページ46', file: 'removal_FY2011_report-H24_phys046.txt' },
  { fiscalYear: 2012, report: '平成25年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo252', page: 'PDF物理ページ52', file: 'removal_FY2012_report-H25_phys052.txt' },
  { fiscalYear: 2013, report: '平成26年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo263', page: 'PDF物理ページ54', file: 'removal_FY2013_report-H26_phys054.txt' },
  { fiscalYear: 2014, report: '平成27年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo273', page: 'PDF物理ページ54', file: 'removal_FY2014_report-H27_phys054.txt' },
  { fiscalYear: 2015, report: '平成28年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/jitenshagenkyo28', page: 'p.50（PDF物理ページ56、画像から目視転記）', file: '' },
  { fiscalYear: 2016, report: '平成29年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo293', page: 'PDF物理ページ56', file: 'removal_FY2016_report-H29_phys056.txt' },
  { fiscalYear: 2017, report: '平成30年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/08_jitensyagenkyo293', page: 'PDF物理ページ57', file: 'removal_FY2017_report-H30_phys057.txt' },
  { fiscalYear: 2018, report: '令和元年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/09_jitensyagenkyo293', page: 'PDF物理ページ57', file: 'removal_FY2018_report-R01_phys057.txt' },
  { fiscalYear: 2019, report: '令和２年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/10_jitensyagenkyo293', page: 'PDF物理ページ57', file: 'removal_FY2019_report-R02_phys057.txt' },
  { fiscalYear: 2020, report: '令和３年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/11_jitensyagenkyo033', page: 'PDF物理ページ57', file: 'removal_FY2020_report-R03_phys057.txt' },
  { fiscalYear: 2021, report: '令和４年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202303_jitensyagenkyo02', page: 'PDF物理ページ57', file: 'removal_FY2021_report-R04_phys057.txt' },
  { fiscalYear: 2022, report: '令和５年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202403_jitensyagenkyo', page: 'PDF物理ページ57', file: 'removal_FY2022_report-R05_phys057.txt' },
  { fiscalYear: 2023, report: '令和６年度調査', url: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202503_jitensyagenkyo', page: 'PDF物理ページ57', file: 'removal_FY2023_report-R06_phys057.txt' },
  { fiscalYear: 2024, report: '令和７年度調査', url: SRC.report.url, page: 'p.51（PDF物理ページ57）', file: 'removal_FY2024_report-R07_phys057.txt' },
];

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------
class CheckError extends Error {}
const checks: string[] = [];
function check(cond: boolean, message: string): void {
  if (!cond) throw new CheckError(`照合失敗: ${message}`);
  checks.push(message);
}
function eq(actual: number, expected: number, message: string, tol = 0): void {
  check(Math.abs(actual - expected) <= tol, `${message}（計算値 ${actual} / 公表値 ${expected}）`);
}
/** 全角・半角スペース、改行を除く */
function squash(s: string): string {
  return s.replace(/\s+/g, ''); // \s は全角スペース（U+3000）も含む
}
function num(s: string): number {
  const v = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(v)) throw new Error(`数値ではない: ${s}`);
  return v;
}
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// 1. 駅別 Excel
// ---------------------------------------------------------------------------
type Area = '区部' | '市部' | '町村部';
interface ExcelRow {
  row: number;
  /** D..O 列（12列） */
  v: number[];
}
interface StationRow extends ExcelRow {
  municipality: string;
  area: Area;
  label: string;
  noParkingZone: boolean;
}

/**
 * セルの値。数式はキャッシュされた計算結果を使う。結果が保存されていない数式
 * （全駅0台の区市町村の「計」行など）は SUM だけを自前で評価する。
 */
function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === 'object' && 'formula' in v) {
    const { formula, result } = v as { formula: string; result?: unknown };
    if (result !== undefined && (typeof result !== 'object' || result === null)) return result;
    return evalSum(cell.worksheet, formula);
  }
  if (v && typeof v === 'object' && 'result' in v) return (v as { result: unknown }).result;
  if (v && typeof v === 'object' && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
  }
  return v;
}

function evalSum(ws: ExcelJS.Worksheet, formula: string): number {
  // 対応する形: SUM(D1:D9,D12) と +D1+E1+F1
  const m = formula.match(/^SUM\(([A-Z0-9:,]+)\)$/);
  const refs = m?.[1]?.split(',') ?? (/^\+?[A-Z]+\d+(\+[A-Z]+\d+)*$/.test(formula) ? formula.replace(/^\+/, '').split('+') : null);
  if (!refs) throw new Error(`評価できない数式: ${formula}`);
  let total = 0;
  for (const part of refs) {
    const [from, to = from] = part.split(':') as [string, string?];
    const a = ws.getCell(from);
    const b = ws.getCell(to);
    for (let r = Number(a.row); r <= Number(b.row); r++) {
      for (let c = Number(a.col); c <= Number(b.col); c++) {
        const x = cellValue(ws.getCell(r, c));
        if (typeof x === 'number') total += x;
      }
    }
  }
  return total;
}

async function readExcel() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(ROOT, SRC.excel.file));
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('シートがない');

  const stations: StationRow[] = [];
  const municipalTotals = new Map<string, ExcelRow & { area: Area }>();
  const areaTotals = new Map<string, ExcelRow>();
  let area: Area = '区部';
  let municipality = '';

  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const a = cellValue(row.getCell(1));
    const b = cellValue(row.getCell(2));
    const c = cellValue(row.getCell(3));
    const d = cellValue(row.getCell(4));
    const aStr = typeof a === 'string' ? squash(a) : '';
    if (aStr === '【市部】') area = '市部';
    if (aStr === '【町部】') area = '町村部';
    if (typeof d !== 'number') continue; // 見出し・注記・空行
    const v: number[] = [];
    for (let col = 4; col <= 15; col++) {
      const x = cellValue(row.getCell(col));
      v.push(typeof x === 'number' ? x : 0);
    }
    if (['総数', '区部計', '市部計', '町村部計'].includes(aStr)) {
      areaTotals.set(aStr, { row: r, v });
      continue;
    }
    // 列Aの区市町村名は、ブロック（ページ）の先頭行にだけ入っている
    if (aStr) municipality = aStr;
    if (b === '計') {
      municipalTotals.set(municipality, { row: r, v, area });
      continue;
    }
    if (typeof c !== 'string' || !squash(c)) throw new Error(`駅名が空: 行${r}`);
    stations.push({
      row: r,
      v,
      municipality,
      area,
      label: c.replace(/\s*\n\s*/g, '').trim(),
      noParkingZone: b === '*',
    });
  }
  return { stations, municipalTotals, areaTotals };
}

// 列の意味（Excel 3〜4行目の見出し）。D..O の順。
const COL = {
  parkedBicycle: 0,
  parkedMopedGeneral: 1,
  parkedMopedSpecific: 2,
  parkedMotorcycle: 3,
  parkedTotal: 4,
  occupancyBicycle: 5,
  occupancyMoped: 6,
  occupancyTotal: 7,
  capacityBicycle: 8,
  capacityMoped: 9,
  capacityTotal: 10,
  inflowTotal: 11,
} as const;

// ---------------------------------------------------------------------------
// 2. 駅の位置（国土数値情報 N02）
// ---------------------------------------------------------------------------
interface N02Feature {
  properties: { N02_003: string; N02_004: string; N02_005: string; N02_005g: string };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}
interface N02Station {
  name: string;
  line: string;
  operator: string;
  lat: number;
  lon: number;
}

/** 東京都（島しょを除く）とその周辺を含む範囲。隣県の同名駅（例: 埼玉県の霞ヶ関駅）をここで除く。 */
const BBOX = { latMin: 35.48, latMax: 35.9, lonMin: 138.9, lonMax: 139.93 };

/** NFKC（N02 は「笹塚」の「塚」に互換漢字 U+FA10 を使っている）＋ ヶ/ケ の表記揺れを吸収 */
function normName(s: string): string {
  return s.normalize('NFKC').replace(/[ヶヵ]/g, 'ケ');
}

/** Excel の駅名表記 → N02 の駅名・路線の対応（表記揺れや路線の指定）。 */
const ALIASES: Record<string, { names: string[]; operator?: string; line?: string; excludeOperator?: string; note: string }> = {
  二重橋: { names: ['二重橋前'], note: 'N02 では「二重橋前」' },
  霞が関: { names: ['霞ケ関'], note: 'N02 では「霞ヶ関」' },
  都電早稲田: { names: ['早稲田'], operator: '東京都', line: '荒川線', note: '都電荒川線の早稲田停留場' },
  都電面影橋: { names: ['面影橋'], operator: '東京都', line: '荒川線', note: '都電荒川線の面影橋停留場' },
  つくばエクスプレス浅草: { names: ['浅草'], operator: '首都圏新都市鉄道', note: 'つくばエクスプレスの浅草駅' },
  京成江戸川: { names: ['江戸川'], operator: '京成電鉄', note: 'N02 では京成本線「江戸川」' },
  永山: { names: ['京王永山', '小田急永山'], note: 'N02 では京王・小田急で別名' },
  // Excel に別の行がある駅（つくばエクスプレス浅草駅・都電早稲田駅）を除く
  浅草: { names: ['浅草'], excludeOperator: '首都圏新都市鉄道', note: 'つくばエクスプレス浅草駅は別の行なので除く' },
  早稲田: { names: ['早稲田'], operator: '東京地下鉄', note: '都電早稲田駅は別の行なので、東京メトロ東西線の早稲田駅' },
};

function loadN02(): N02Station[] {
  const gj = JSON.parse(readFileSync(join(RAW, 'n02/N02-24_Station.geojson'), 'utf8')) as {
    features: N02Feature[];
  };
  const out: N02Station[] = [];
  for (const f of gj.features) {
    const cs = f.geometry.coordinates;
    const lon = sum(cs.map((c) => c[0])) / cs.length;
    const lat = sum(cs.map((c) => c[1])) / cs.length;
    if (lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) continue;
    out.push({ name: normName(f.properties.N02_005), line: f.properties.N02_003, operator: f.properties.N02_004, lat, lon });
  }
  return out;
}

function distM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

interface Cluster {
  lat: number;
  lon: number;
  members: N02Station[];
}
/** 同名の駅を 1.5 km 以内でまとめる（同じ駅の複数路線は1つ、離れた同名駅は別クラスタ）。 */
function clusterByDistance(list: N02Station[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const s of list) {
    const c = clusters.find((k) => distM(k.lat, k.lon, s.lat, s.lon) < 1500);
    if (c) {
      c.members.push(s);
      c.lat = sum(c.members.map((m) => m.lat)) / c.members.length;
      c.lon = sum(c.members.map((m) => m.lon)) / c.members.length;
    } else clusters.push({ lat: s.lat, lon: s.lon, members: [s] });
  }
  return clusters;
}

interface NameResolution {
  /** Excel 上の駅名（「駅」を除く） */
  name: string;
  status: 'matched' | 'unmatched';
  candidates: Cluster[];
  aliasNote?: string;
}

function resolveNames(label: string, index: Map<string, N02Station[]>): NameResolution[] {
  const lookup = (name: string): { clusters: Cluster[]; aliasNote?: string } => {
    const alias = ALIASES[name];
    if (alias) {
      const list = alias.names
        .flatMap((n) => index.get(normName(n)) ?? [])
        .filter(
          (s) =>
            (!alias.operator || s.operator === alias.operator) &&
            (!alias.line || s.line === alias.line) &&
            s.operator !== alias.excludeOperator,
        );
      return { clusters: clusterByDistance(list), aliasNote: alias.note };
    }
    return { clusters: clusterByDistance(index.get(normName(name)) ?? []) };
  };
  const stripEki = (s: string) => s.replace(/駅$/, '');
  // ラベル全体が1駅名のことがある（例: 大塚・帝京大学駅）
  const whole = stripEki(label);
  if (index.has(normName(whole))) {
    return [{ name: whole, status: 'matched', candidates: lookup(whole).clusters }];
  }
  const out: NameResolution[] = [];
  for (const tok of label.split(/[、，,]/).map((t) => t.trim()).filter(Boolean)) {
    const t = stripEki(tok);
    let parts = [t];
    if (!index.has(normName(t)) && !ALIASES[t] && /・/.test(t)) parts = t.split('・').map(stripEki);
    for (const p of parts) {
      const { clusters, aliasNote } = lookup(p);
      out.push({ name: p, status: clusters.length ? 'matched' : 'unmatched', candidates: clusters, aliasNote });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. PDF 抽出テキストの表を読む
// ---------------------------------------------------------------------------
interface RemovalRow {
  name: string;
  removed: { total: number; bicycle: number; moped: number };
  returned: { total: number; bicycle: number; moped: number };
  disposed: { total: number; bicycle: number; moped: number };
  returnRatePercent: number | null;
}

const NUM_RE = /^-?[\d,]+(\.\d+)?$/;

/** 「名前 + 数値9個 + 返還率」の行を読む。 */
function parseRemovalLine(line: string): RemovalRow | null {
  const m = line.match(/^\s*([^\d\s-][^\d]*?)\s+((?:-?[\d,.]+\s+){9})(-?[\d.]+%|-)\s*$/);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const nums = m[2].trim().split(/\s+/);
  if (nums.length !== 9 || !nums.every((x) => NUM_RE.test(x))) return null;
  const n = nums.map(num);
  const rate = m[3] === '-' ? null : Number(m[3].replace('%', ''));
  return {
    name: squash(m[1]),
    removed: { total: n[0]!, bicycle: n[1]!, moped: n[2]! },
    returned: { total: n[3]!, bicycle: n[4]!, moped: n[5]! },
    disposed: { total: n[6]!, bicycle: n[7]!, moped: n[8]! },
    returnRatePercent: rate,
  };
}

function parseRemovalTable(file: string): Map<string, RemovalRow> {
  const text = readFileSync(join(RAW, 'extracts', file), 'utf8');
  const rows = new Map<string, RemovalRow>();
  for (const line of text.split('\n')) {
    const r = parseRemovalLine(line);
    if (r) rows.set(r.name, r);
  }
  return rows;
}

function readCsv(file: string): Record<string, string>[] {
  const lines = readFileSync(join(RAW, 'transcribed', file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'));
  const header = (lines.shift() ?? '').split(',');
  return lines.map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}
const optNum = (s: string | undefined): number | null => (s === undefined || s === '' ? null : num(s));

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { stations, municipalTotals, areaTotals } = await readExcel();

  // --- Excel 内部の整合（駅の合計 = 区市町村計 = 区部/市部/町村部計 = 総数） ---
  const munNames = [...municipalTotals.keys()];
  for (const [mun, tot] of municipalTotals) {
    const rows = stations.filter((s) => s.municipality === mun);
    check(rows.length > 0, `${mun} に駅がある`);
    for (let k = 0; k < 12; k++) {
      eq(round3(sum(rows.map((s) => s.v[k]!))), round3(tot.v[k]!), `Excel ${mun} 列${k} の駅合計 = 計（行${tot.row}）`, 0.001);
    }
  }
  const areaKey: Record<Area, string> = { 区部: '区部計', 市部: '市部計', 町村部: '町村部計' };
  for (const area of ['区部', '市部', '町村部'] as Area[]) {
    const tot = areaTotals.get(areaKey[area]);
    if (!tot) throw new Error(`${areaKey[area]} がない`);
    const rows = stations.filter((s) => s.area === area);
    for (let k = 0; k < 12; k++) {
      eq(round3(sum(rows.map((s) => s.v[k]!))), round3(tot.v[k]!), `Excel ${areaKey[area]} 列${k} の駅合計`, 0.001);
    }
  }
  const grand = areaTotals.get('総数');
  if (!grand) throw new Error('総数がない');
  for (let k = 0; k < 12; k++) {
    eq(round3(sum(stations.map((s) => s.v[k]!))), round3(grand.v[k]!), `Excel 総数 列${k} の駅合計`, 0.001);
  }
  // 行内の整合
  for (const s of stations) {
    const v = s.v;
    eq(v[COL.parkedBicycle]! + v[COL.parkedMopedGeneral]! + v[COL.parkedMopedSpecific]! + v[COL.parkedMotorcycle]!, v[COL.parkedTotal]!, `行${s.row} ${s.label} 放置台数の内訳の和 = 計`);
    eq(v[COL.parkedTotal]! + v[COL.occupancyTotal]!, v[COL.inflowTotal]!, `行${s.row} ${s.label} 放置台数計 + 実収容台数計 = 乗入台数`);
  }

  // --- 公表値（PDF・報道発表）との照合 ---
  const G = (k: number) => grand.v[k]!;
  eq(G(COL.parkedBicycle), 13394, '自転車の放置台数（概要PDF p.1「13,394台」、報道発表）');
  eq(G(COL.parkedTotal), 14366, '自転車・原付・自二の放置台数（概要PDF p.1「14,366台」）');
  eq(G(COL.inflowTotal), 563857, '乗入台数（概要PDF p.1「563,857台」）');
  eq(G(COL.parkedBicycle) + G(COL.occupancyBicycle), 545983, '自転車の乗入台数（概要PDF p.1「545,983台」）');
  eq(G(COL.occupancyBicycle), 532589, '自転車の駐車台数（概要PDF p.1「532,589台」）');
  eq(G(COL.capacityTotal), 897461, '収容能力（概要PDF p.3「897,461台」）');
  eq(G(COL.occupancyTotal), 549491, '実収容台数（概要PDF p.3「549,491台」）');
  eq(G(COL.parkedMopedGeneral), 538, '一般原付の放置台数（全文 p.7 合計行）');
  eq(G(COL.parkedMopedSpecific), 55, '特定原付の放置台数（全文 p.7 合計行）');
  eq(G(COL.parkedMotorcycle), 379, '自二の放置台数（全文 p.7 合計行）');

  // 全文 p.7（区市町村別）の自転車放置台数と放置率を照合
  const p7 = readFileSync(join(RAW, 'extracts/report-R07_phys013.txt'), 'utf8');
  const p7rows = new Map<string, { bicycle: number; rate: number }>();
  for (const line of p7.split('\n')) {
    const m = line.match(/^\s*([^\d\s][^\d]*?)\s+([\d,]+)\s.*\s([\d.]+)\s*$/);
    if (m && m[1] && m[2] && m[3]) p7rows.set(squash(m[1]), { bicycle: num(m[2]), rate: Number(m[3]) });
  }
  for (const mun of munNames) {
    const tot = municipalTotals.get(mun)!;
    const pub = p7rows.get(mun);
    if (tot.v[COL.parkedTotal] === 0) {
      check(!pub, `全文 p.7 で ${mun} は空欄（放置0台）`);
      continue;
    }
    check(!!pub, `全文 p.7 に ${mun} の行がある`);
    eq(tot.v[COL.parkedBicycle]!, pub!.bicycle, `全文 p.7 ${mun} 自転車放置台数`);
    // p.7 の「自転車の放置率」は 自転車放置台数 ÷ 乗入台数（自転車・原付・自二の計）で計算されている
    eq(Math.round((tot.v[COL.parkedBicycle]! / tot.v[COL.inflowTotal]!) * 1000) / 10, pub!.rate, `全文 p.7 ${mun} 放置率`, 0.051);
  }
  // 放置自転車のある駅数（全文 p.7 合計行: 1〜99台 501駅、100〜499台 29駅、計 530駅）
  const withBikes = stations.filter((s) => s.v[COL.parkedBicycle]! > 0);
  eq(withBikes.filter((s) => s.v[COL.parkedBicycle]! < 100).length, 501, '放置自転車1〜99台の駅数（全文 p.7）');
  eq(withBikes.filter((s) => s.v[COL.parkedBicycle]! >= 100).length, 29, '放置自転車100台以上の駅数（全文 p.6・p.7）');
  // 概要 p.1 の区部/市部/町村部の放置率（自転車放置台数 ÷ 自転車の乗入台数）
  const bikeRate = (vv: number[]) => vv[COL.parkedBicycle]! / (vv[COL.parkedBicycle]! + vv[COL.occupancyBicycle]!);
  eq(Math.round(bikeRate(areaTotals.get('区部計')!.v) * 1000) / 10, 3.7, '区部の自転車放置率（概要 p.1「3.7％」）');
  eq(Math.round(bikeRate(areaTotals.get('市部計')!.v) * 1000) / 10, 0.4, '市部の自転車放置率（概要 p.1「0.4％」）');
  eq(Math.round(bikeRate(areaTotals.get('町村部計')!.v) * 1000) / 10, 0.4, '町村部の自転車放置率（概要 p.1「0.4％」）');
  for (const [mun, rate] of [['千代田区', 46.5], ['中央区', 24.7], ['渋谷区', 23.1], ['文京区', 19.4], ['台東区', 19.1]] as const) {
    eq(Math.round(bikeRate(municipalTotals.get(mun)!.v) * 1000) / 10, rate, `${mun} の自転車放置率（概要 p.1）`);
  }

  // --- 位置合わせ ---
  const n02 = loadN02();
  const index = new Map<string, N02Station[]>();
  for (const s of n02) index.set(s.name, [...(index.get(s.name) ?? []), s]);

  const resolved = stations.map((s) => resolveNames(s.label, index));
  // 区市町村の基準点: 候補が1つに決まる駅名の位置の中央値
  const median = (xs: number[]) => {
    const a = [...xs].sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)]!;
  };
  const munRef = new Map<string, { lat: number; lon: number }>();
  for (const mun of munNames) {
    const pts = stations
      .map((s, i) => ({ s, r: resolved[i]! }))
      .filter(({ s }) => s.municipality === mun)
      .flatMap(({ r }) => r.filter((x) => x.candidates.length === 1).map((x) => x.candidates[0]!));
    if (pts.length) munRef.set(mun, { lat: median(pts.map((p) => p.lat)), lon: median(pts.map((p) => p.lon)) });
  }

  const ambiguousChoices: string[] = [];
  const stationOut = stations.map((s, i) => {
    const res = resolved[i]!;
    const ref = munRef.get(s.municipality);
    const matched = res
      .filter((r) => r.status === 'matched')
      .map((r) => {
        let chosen = r.candidates[0]!;
        if (r.candidates.length > 1) {
          if (!ref) throw new Error(`${s.municipality} の基準点がない`);
          chosen = [...r.candidates].sort((a, b) => distM(a.lat, a.lon, ref.lat, ref.lon) - distM(b.lat, b.lon, ref.lat, ref.lon))[0]!;
          ambiguousChoices.push(`${s.municipality} ${r.name}: 同名駅 ${r.candidates.length} か所から区市町村の基準点に最も近いもの（${[...new Set(chosen.members.map((m) => m.operator))].join('・')}）を採用`);
        }
        return { name: r.name, chosen, aliasNote: r.aliasNote };
      });
    const unmatched = res.filter((r) => r.status === 'unmatched').map((r) => r.name);
    const lat = matched.length ? sum(matched.map((m) => m.chosen.lat)) / matched.length : null;
    const lon = matched.length ? sum(matched.map((m) => m.chosen.lon)) / matched.length : null;
    const spread = lat !== null && lon !== null ? Math.max(...matched.map((m) => distM(lat, lon, m.chosen.lat, m.chosen.lon))) : null;
    const v = s.v;
    return {
      id: `s${String(i + 1).padStart(3, '0')}`,
      name: s.label,
      stationNames: res.map((r) => r.name),
      // 同じ駅が複数の区市町村に別行で計上されている（例: 東京駅）。同じ siteKey の行は同じ場所。
      siteKey: [...new Set(res.map((r) => normName(r.name)))].sort().join('・'),
      municipality: s.municipality,
      area: s.area,
      noParkingZone: s.noParkingZone,
      lat: lat === null ? null : round6(lat),
      lon: lon === null ? null : round6(lon),
      parked: {
        bicycle: v[COL.parkedBicycle]!,
        mopedGeneral: v[COL.parkedMopedGeneral]!,
        mopedSpecific: v[COL.parkedMopedSpecific]!,
        motorcycle: v[COL.parkedMotorcycle]!,
        total: v[COL.parkedTotal]!,
      },
      occupancy: { bicycle: v[COL.occupancyBicycle]!, moped: v[COL.occupancyMoped]!, total: v[COL.occupancyTotal]! },
      capacity: { bicycle: round3(v[COL.capacityBicycle]!), moped: round3(v[COL.capacityMoped]!), total: round3(v[COL.capacityTotal]!) },
      inflow: { total: v[COL.inflowTotal]!, bicycle: v[COL.parkedBicycle]! + v[COL.occupancyBicycle]! },
      geo: {
        source: 'N02-24',
        matched: matched.map((m) => ({
          name: m.name,
          lines: [...new Set(m.chosen.members.map((x) => `${x.operator} ${x.line}`))],
          ...(m.aliasNote ? { note: m.aliasNote } : {}),
        })),
        unmatched,
        spreadM: spread === null ? null : Math.round(spread),
      },
      excelRow: s.row,
    };
  });

  // 区市町村の基準点から遠すぎる駅は位置の取り違えとみなして止める
  for (const st of stationOut) {
    const ref = munRef.get(st.municipality);
    if (st.lat === null || st.lon === null || !ref) continue;
    const d = distM(st.lat, st.lon, ref.lat, ref.lon);
    check(d < 15000, `${st.municipality} ${st.name} が区市町村の基準点から 15 km 以内（${Math.round(d)} m）`);
  }

  // --- 撤去・返還・処分（区市町村別、令和6年度） ---
  const removal2024 = parseRemovalTable('removal_FY2024_report-R07_phys057.txt');
  const total2024 = removal2024.get('総数');
  if (!total2024) throw new Error('撤去表の総数行がない');
  eq(total2024.removed.total, 188561, '撤去台数（概要 p.3「188,561台」）');
  eq(total2024.returned.total, 121425, '返還台数（概要 p.3「121,425台」）');
  eq(total2024.disposed.total, 67831, '処分台数（概要 p.3「67,831台」）');
  // 撤去表の区市町村（53）。Excel には駅のない檜原村がないので、撤去表の並びを正とする。
  const removalNames = [...removal2024.keys()].filter((k) => !['総数', '区部計', '市部計', '町村部計'].includes(k));
  check(removalNames.length === 53 && removal2024.size === 57, `撤去表は 53 区市町村 + 4 集計行（読めた行数 ${removal2024.size}）`);
  for (const m of munNames) check(removalNames.includes(m), `Excel の ${m} が撤去表にある`);
  const removalMun = removalNames.map((m) => removal2024.get(m)!);
  for (const k of ['removed', 'returned', 'disposed'] as const) {
    for (const f of ['total', 'bicycle', 'moped'] as const) {
      eq(round3(sum(removalMun.map((r) => r[k][f]))), total2024[k][f], `撤去表 ${k}.${f} の区市町村合計 = 総数`, 0.001);
    }
  }
  // 「計 = 自転車 + 原付」が成り立たない行（原本どおり出力し、notes に残す）
  const removalNotes = new Map<string, string[]>();
  for (const r of [...removalMun, total2024]) {
    for (const k of ['removed', 'returned', 'disposed'] as const) {
      const diff = round3(r[k].total - r[k].bicycle - r[k].moped);
      if (diff !== 0) {
        const msg = `原本の表で ${k === 'removed' ? '撤去' : k === 'returned' ? '返還' : '処分'}台数の「計」が「自転車＋原付」より ${diff} 台多い（原本どおり収録）`;
        removalNotes.set(r.name, [...(removalNotes.get(r.name) ?? []), msg]);
      }
    }
  }

  const areaOf = (m: string): Area => (/区$/.test(m) ? '区部' : /市$/.test(m) ? '市部' : '町村部');
  const municipalitiesOut = removalNames.map((m) => {
    const t = municipalTotals.get(m);
    const r = removal2024.get(m)!;
    const st = stationOut.filter((s) => s.municipality === m);
    const v = t?.v;
    check(!t || t.area === areaOf(m), `${m} の区分`);
    return {
      name: m,
      area: areaOf(m),
      stationCount: st.length,
      stationsWithParkedBicycles: st.filter((s) => s.parked.bicycle > 0).length,
      // 駅別表に駅がない区市町村（檜原村）は null
      parked: v
        ? {
            bicycle: v[COL.parkedBicycle]!,
            mopedGeneral: v[COL.parkedMopedGeneral]!,
            mopedSpecific: v[COL.parkedMopedSpecific]!,
            motorcycle: v[COL.parkedMotorcycle]!,
            total: v[COL.parkedTotal]!,
          }
        : null,
      occupancy: v ? { bicycle: v[COL.occupancyBicycle]!, moped: v[COL.occupancyMoped]!, total: v[COL.occupancyTotal]! } : null,
      capacity: v ? { bicycle: round3(v[COL.capacityBicycle]!), moped: round3(v[COL.capacityMoped]!), total: round3(v[COL.capacityTotal]!) } : null,
      inflow: v ? { total: v[COL.inflowTotal]!, bicycle: v[COL.parkedBicycle]! + v[COL.occupancyBicycle]! } : null,
      bicycleParkedRatePercent: v && v[COL.parkedBicycle]! + v[COL.occupancyBicycle]! > 0 ? round1(bikeRate(v) * 100) : null,
      removalFY2024: {
        removed: r.removed,
        returned: r.returned,
        disposed: r.disposed,
        returnRatePercent: r.returnRatePercent,
        ...(removalNotes.has(m) ? { notes: removalNotes.get(m) } : {}),
      },
    };
  });

  // --- 年度推移 ---
  const trend = readCsv('tokyo_trend_R07_p26-27.csv').map((r) => {
    const inflow = num(r.inflow_total!);
    const occupancy = num(r.occupancy_total!);
    const parked = num(r.parked_total!);
    const pMoped = optNum(r.parked_moped_motorcycle);
    eq(occupancy + parked, inflow, `推移表 ${r.era_label} 実収容 + 放置 = 乗入`);
    const iMoped = optNum(r.inflow_moped_motorcycle);
    const oMoped = optNum(r.occupancy_moped_motorcycle);
    if (iMoped !== null && oMoped !== null && pMoped !== null) eq(oMoped + pMoped, iMoped, `推移表 ${r.era_label} 内数 実収容 + 放置 = 乗入`);
    const year = num(r.survey_year!);
    return {
      surveyYear: year,
      label: r.era_label!,
      countingMethod: year <= 2011 ? 'threshold' : 'all',
      parked: { total: parked, mopedMotorcycle: pMoped, bicycle: pMoped === null ? null : parked - pMoped },
      occupancy: { total: occupancy, mopedMotorcycle: oMoped },
      inflow: { total: inflow, mopedMotorcycle: iMoped },
    };
  });
  const last = trend[trend.length - 1]!;
  eq(last.parked.total, G(COL.parkedTotal), '推移表 令和7年 放置台数 = Excel 総数');
  eq(last.parked.bicycle ?? -1, G(COL.parkedBicycle), '推移表 令和7年 自転車放置台数（計−内数）= Excel 総数');
  eq(last.occupancy.total, G(COL.occupancyTotal), '推移表 令和7年 実収容台数 = Excel 総数');
  const r6 = trend.find((t) => t.surveyYear === 2024)!;
  eq(r6.parked.total - last.parked.total, 1676, '放置台数の前年度比（概要 p.1「1,676台減」）');
  eq((r6.parked.bicycle ?? 0) - (last.parked.bicycle ?? 0), 1482, '自転車放置台数の前年度比（概要 p.1「1,482台減」）');
  eq(r6.parked.bicycle ?? -1, 14876, '令和6年の自転車放置台数（報道発表「14,876台」）');

  const manual2015 = readCsv('removal_FY2015_report-H28_p50.csv')[0]!;
  const removalTrend = REMOVAL_REPORTS.map((rep) => {
    let row: RemovalRow;
    if (rep.fiscalYear === 2015) {
      row = {
        name: '総数',
        removed: { total: num(manual2015.removed_total!), bicycle: num(manual2015.removed_bicycle!), moped: num(manual2015.removed_moped!) },
        returned: { total: num(manual2015.returned_total!), bicycle: num(manual2015.returned_bicycle!), moped: num(manual2015.returned_moped!) },
        disposed: { total: num(manual2015.disposed_total!), bicycle: num(manual2015.disposed_bicycle!), moped: num(manual2015.disposed_moped!) },
        returnRatePercent: num(manual2015.return_rate_percent!),
      };
    } else {
      const t = parseRemovalTable(rep.file).get('総数');
      if (!t) throw new Error(`${rep.file} に総数行がない`);
      row = t;
    }
    const notes: string[] = [];
    for (const [k, label] of [['removed', '撤去'], ['returned', '返還'], ['disposed', '処分']] as const) {
      const diff = round3(row[k].total - row[k].bicycle - row[k].moped);
      if (diff !== 0) notes.push(`原本の表で${label}台数の「計」が「自転車＋原付」より ${diff} 台多い（原本どおり収録）`);
    }
    return {
      fiscalYear: rep.fiscalYear,
      removed: row.removed,
      returned: row.returned,
      disposed: row.disposed,
      returnRatePercent: row.returnRatePercent,
      ...(notes.length ? { notes } : {}),
      source: { document: `駅前放置自転車等の現況と対策 －${rep.report}－（全文）区市町村の撤去・返還・処分状況 総数行`, url: rep.url, page: rep.page },
    };
  });
  const rm23 = removalTrend.find((r) => r.fiscalYear === 2023)!;
  eq(rm23.removed.total - total2024.removed.total, 12513, '撤去台数の前年度比（概要 p.3「５年度比 12,513台減」）');
  eq(rm23.returned.total - total2024.returned.total, 7873, '返還台数の前年度比（概要 p.3「7,873台減」）');
  eq(rm23.disposed.total - total2024.disposed.total, 5035, '処分台数の前年度比（概要 p.3「5,035台減」）');

  // --- 主要数値 ---
  const page = (p: string) => p;
  const summary = {
    title: '東京都 駅前放置自転車の主要数値',
    generatedFrom: 'scripts/data/build-bicycles.ts',
    note: '「放置」は駅から概ね半径500m以内の路上等に置かれ、利用者が直ちに移動できない状態のもの。島しょ部を除く。',
    metrics: [
      metric('bicycleParked', '放置自転車の台数（1日）', G(COL.parkedBicycle), '台', '2025年10月中の晴天の平日1日・午前11時頃（令和7年度調査）',
        '駅周辺（概ね半径500m以内）で自転車等駐車場以外の道路等に放置されていた自転車。原付・自二を含まない。', [
          src(SRC.gaiyou, page('p.1「１ 駅周辺における自転車等の放置状況」')),
          src(SRC.excel, '総数行 D列（自転車）'),
          src(SRC.press, '「自転車の放置台数」表'),
        ]),
      metric('allParked', '放置台数（自転車・原付・自二の計）', G(COL.parkedTotal), '台', '2025年10月（令和7年度調査）',
        '自転車、原動機付自転車（一般原付・特定原付）、自動二輪車の放置台数の合計。', [src(SRC.gaiyou, 'p.1 (1)'), src(SRC.excel, '総数行 H列')]),
      metric('bicycleParkedPrevYear', '放置自転車の台数（前年）', r6.parked.bicycle, '台', '2024年10月（令和6年度調査）', '同上の前年値。',
        [src(SRC.press, '「自転車の放置台数」表 令和6年'), src(SRC.report, 'p.27 推移表 令和6年（放置台数16,042 − 原付・自二1,166）')]),
      metric('bicycleInflow', '自転車の乗入台数', G(COL.parkedBicycle) + G(COL.occupancyBicycle), '台', '2025年10月（令和7年度調査）',
        '駅周辺に乗り入れた自転車（放置台数 + 自転車等駐車場の実収容台数）。', [src(SRC.gaiyou, 'p.1')]),
      metric('bicycleParkedRate', '自転車の放置率（都全体）', round1((G(COL.parkedBicycle) / (G(COL.parkedBicycle) + G(COL.occupancyBicycle))) * 100), '%', '2025年10月',
        '自転車放置台数 ÷ 自転車の乗入台数。概要 p.1 は「約2.5％」と記載。', [src(SRC.gaiyou, 'p.1')]),
      metric('allInflow', '乗入台数（自転車・原付・自二）', G(COL.inflowTotal), '台', '2025年10月', '放置台数と自転車等駐車場の駐車台数（実収容台数）の合計。', [src(SRC.gaiyou, 'p.1'), src(SRC.excel, '総数行 O列')]),
      metric('parkingCapacity', '自転車等駐車場の収容能力', G(COL.capacityTotal), '台', '2025年8月末', '駅周辺の自転車等駐車場の整備計画上の収容予定台数。', [src(SRC.gaiyou, 'p.3 4(2)'), src(SRC.excel, '総数行 N列')]),
      metric('parkingOccupancy', '自転車等駐車場の実収容台数', G(COL.occupancyTotal), '台', '2025年10月の調査日', '調査時に自転車等駐車場に実際に駐車していた台数。', [src(SRC.gaiyou, 'p.3 4(2)'), src(SRC.excel, '総数行 K列')]),
      metric('parkingLots', '駅周辺の自転車等駐車場の数', 2943, '箇所', '2025年8月末', '公設1,326・民設1,617。', [src(SRC.gaiyou, 'p.3 4(1)')]),
      metric('stationsSurveyed', '調査対象の駅（Excel の行数）', stations.length, '駅', '2025年10月',
        'Excel の駅別表の行数。近接する複数駅を1行にまとめた行や、複数区市町村にまたがる駅（例: 東京駅）を区市町村ごとに別行にした行を含む。', [src(SRC.excel, '駅別の行')]),
      metric('stationsWithParkedBicycles', '放置自転車のある駅', withBikes.length, '駅', '2025年10月', '放置自転車が1台以上の駅（Excel の行単位）。', [src(SRC.report, 'p.7 合計行「計 530」')]),
      metric('stationsWith100PlusBicycles', '放置自転車が100台以上の駅', 29, '駅', '2025年10月', 'Excel の行単位。', [src(SRC.report, 'p.6 (2)・p.7 合計行')]),
      metric('removedFY2024', '撤去された放置自転車等（年間）', total2024.removed.total, '台', '2024年度（令和6年度）',
        '区市町村が撤去した自転車と原付の合計（自二を含まない）。区市町村単位の集計で、駅単位の値は公表されていない。', [src(SRC.gaiyou, 'p.3 5(1)'), src(SRC.report, 'p.51 (3) 総数行')]),
      metric('removedBicycleFY2024', '撤去された自転車（年間）', total2024.removed.bicycle, '台', '2024年度', '上のうち自転車。', [src(SRC.report, 'p.51 (3) 総数行 自転車')]),
      metric('returnedFY2024', '持ち主に返還された台数', total2024.returned.total, '台', '2024年度',
        '自転車と原付の合計。前年度に撤去されたものを含み、当年度の撤去分のうち翌年度に返還されるものを含まない。', [src(SRC.gaiyou, 'p.3 5(2)'), src(SRC.report, 'p.51 (3)')]),
      metric('disposedFY2024', '区市町村が処分した台数', total2024.disposed.total, '台', '2024年度',
        '自転車と原付の合計。前年度に撤去されたものや、粗大ごみとして収集されたもの等を含む場合がある。', [src(SRC.gaiyou, 'p.3 5(3)'), src(SRC.report, 'p.51 (3)・凡例 2(3)')]),
      metric('disposedRecycledFY2024', '処分のうちリサイクル用途（自転車として再利用）', 51646, '台', '2024年度', '売却（F）47,210台と無償（G）4,436台の計。処分台数の76.1％。', [src(SRC.gaiyou, 'p.3 図-7'), src(SRC.report, 'p.50 (2)')]),
      metric('disposedScrapFY2024', '処分のうち鉄くずとして資源活用', 6360, '台', '2024年度', '処分台数の9.4％。', [src(SRC.gaiyou, 'p.3 図-7')]),
      metric('disposedWasteFY2024', '処分のうち廃棄', 9825, '台', '2024年度', '有償8,619台・無償1,206台。処分台数の14.5％。', [src(SRC.gaiyou, 'p.3 図-7'), src(SRC.report, 'p.50 (2)')]),
      metric('removalCostFY2024', '放置自転車の撤去・保管・返還の経費', 53.7, '億円', '2024年度', '区市町村の経費の合計。', [src(SRC.gaiyou, 'p.2 3(2)')]),
      metric('campaignRemoved', 'クリーンキャンペーン期間中の撤去台数', 6987, '台', '2025年10月', '542駅で実施。', [src(SRC.gaiyou, 'p.2 3(4)')]),
      metric('peakAllParked', '放置台数の過去最多（自転車・原付・自二）', 242760, '台', '1990年（平成2年）',
        '当時の調査方式（自転車100台以上、原付・自二は合わせて50台以上の駅のみ計上）による値。', [src(SRC.press, '「最も多かった平成2年」'), src(SRC.report, 'p.3「平成２年の約24.3万台をピーク」')]),
      metric('targetBicycleParked', '都の目標（放置自転車）', 15000, '台以下', '2025年度中', '東京都自転車安全利用推進計画の数値目標。', [src(SRC.press, '【注2】')]),
    ],
  };

  // --- 書き出し ---
  mkdirSync(OUT, { recursive: true });
  const meta = (title: string, sources: object[]) => ({ title, sources, generatedBy: 'scripts/data/build-bicycles.ts' });
  write('stations.json', {
    ...meta('駅別の放置自転車等（令和7年度調査・2025年10月）', [src(SRC.excel, '駅別の行'), src(SRC.n02, 'N02-24_Station（位置）')]),
    count: stationOut.length,
    stations: stationOut,
  });
  write('municipalities.json', {
    ...meta('区市町村別の放置台数（2025年10月）と撤去・返還・処分台数（2024年度）', [
      src(SRC.excel, '区市町村の「計」行'),
      src(SRC.report, 'p.51 (3) 区市町村の撤去・返還・処分状況（令和6年度）'),
    ]),
    count: municipalitiesOut.length,
    totals: {
      parked: { bicycle: G(COL.parkedBicycle), total: G(COL.parkedTotal) },
      removalFY2024: { removed: total2024.removed, returned: total2024.returned, disposed: total2024.disposed, returnRatePercent: total2024.returnRatePercent, ...(removalNotes.has('総数') ? { notes: removalNotes.get('総数') } : {}) },
    },
    municipalities: municipalitiesOut,
  });
  write('timeseries.json', {
    ...meta('東京都全体の推移', []),
    parking: {
      description: '駅周辺の乗入台数・実収容台数・放置台数（各年の調査日1日の値、島しょを除く都全体）',
      source: src(SRC.report, 'p.26-27 第1-1-(8) 乗入台数・実収容台数・放置台数の推移「都」の行'),
      series: trend,
    },
    removal: {
      description: '区市町村が撤去・返還・処分した放置自転車等（自転車と原付）の年度合計',
      series: removalTrend,
    },
  });
  write('summary.json', summary);

  // --- 報告 ---
  const unmatchedList = stationOut.filter((s) => s.geo.unmatched.length);
  const noGeo = stationOut.filter((s) => s.lat === null);
  const wide = stationOut.filter((s) => (s.geo.spreadM ?? 0) > 800);
  const top = [...stationOut].sort((a, b) => b.parked.bicycle - a.parked.bicycle).slice(0, 10);
  console.log(`照合 ${checks.length} 件すべて一致`);
  console.log(`駅（Excel の行）: ${stationOut.length} / 区市町村: ${municipalitiesOut.length}`);
  console.log(`駅名の照合: 駅名 ${resolved.flat().length} 件中 未照合 ${resolved.flat().filter((r) => r.status === 'unmatched').length} 件`);
  for (const s of unmatchedList) console.log(`  未照合: ${s.municipality} ${s.name} → ${s.geo.unmatched.join('、')}（位置 ${s.lat === null ? 'なし' : '他の駅名から算出'}、放置自転車 ${s.parked.bicycle} 台）`);
  console.log(`位置なしの行: ${noGeo.length}`);
  for (const a of [...new Set(ambiguousChoices)]) console.log(`  同名駅: ${a}`);
  for (const s of wide) console.log(`  まとめ行の広がり > 800 m: ${s.municipality} ${s.name} ${s.geo.spreadM} m`);
  console.log('放置自転車の多い駅（Excel の行単位）:');
  for (const s of top) console.log(`  ${s.parked.bicycle}\t${s.municipality}\t${s.name}`);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
function src(s: { document: string; url: string }, location: string) {
  return { document: s.document, url: s.url, location };
}
function metric(id: string, label: string, value: number | null, unit: string, period: string, definition: string, sources: object[]) {
  return { id, label, value, unit, period, definition, sources };
}
function write(name: string, data: unknown): void {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 1) + '\n');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
