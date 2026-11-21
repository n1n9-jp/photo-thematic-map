/**
 * 駅ごとの放置自転車の台数。`public/data/bicycles/stations.json`（663行）を、
 * 同じ場所（`siteKey`）ごとに合算した「場所」の配列にする。
 *
 * - 同じ `siteKey` の行は、区市町村をまたぐ駅（例: 飯田橋駅は3行）を合算する。位置は行の緯度経度の平均。
 * - 東京駅と国立競技場駅は区をまたぐために `siteKey` が2つに分かれているので、
 *   同じ駅名を含み、300m 以内にある場所はさらに1か所にまとめる（位置は台数で重み付けした平均）。
 * - 合算しても都全体の台数（13,394台）は変わらない。台数0の場所は既定で除く。
 *
 * 合算は純粋関数（`aggregateStationSites`）。読み込みだけが `fetch` に依存する。
 */
import { assetUrl } from '../paths';

/** `stations.json` の行のうち、合算に使う項目。 */
export interface StationRow {
  name: string;
  stationNames: string[];
  siteKey: string;
  municipality: string;
  lat: number;
  lon: number;
  parked: { bicycle: number };
  /** 自転車の収容能力・止まっていた台数（駐輪場）。省略時は 0 として合算する。 */
  capacity?: { bicycle: number };
  occupancy?: { bicycle: number };
  /** 位置に使った駅と、その駅を通る路線。複数駅をまとめた場所で、主な駅（路線が多い駅）を選ぶのに使う。 */
  geo?: { matched?: { name: string; lines: string[] }[] };
}

/** 同じ場所を合算した結果。 */
export interface StationSite {
  /** 場所の名前（例: 「小川町・新御茶ノ水・淡路町」）。同じ場所で台数が最も多い `siteKey`。 */
  name: string;
  /**
   * ラベル用の短い名前。主な駅（通る路線が多い駅）を2つまで「・」で並べ、3駅以上をまとめた場所は「ほか」を付ける
   * （例: 「東京・大手町ほか」）。
   */
  shortName: string;
  /** 区市町村。複数にまたがる場所は、台数が最も多い行のもの。 */
  municipality: string;
  lat: number;
  lon: number;
  /** 放置自転車の台数（`parked.bicycle` の合計）。 */
  bicycles: number;
  /** 駐輪場の収容能力（自転車）の合計。 */
  capacity: number;
  /** 調査のときに駐輪場に止まっていた台数（自転車）の合計。 */
  occupancy: number;
  /** 駐輪場の空き（収容能力 − 止まっていた台数）が放置台数以上か。場所ごとに合算した値で判定する。 */
  vacancyCoversParked: boolean;
  /** 含まれる駅名（「駅」を除く）。 */
  stationNames: string[];
}

export interface AggregateOptions {
  /** 台数0の場所を除くか（既定 true）。 */
  dropEmpty?: boolean;
  /** 同名の駅をまとめる距離(m)の上限（既定 300）。 */
  mergeDistanceM?: number;
}

export const DEFAULT_MERGE_DISTANCE_M = 300;

const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180;

/** 2点間の距離(m)。数百m 程度の近さを判定するための球面近似（haversine）。 */
export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * DEG2RAD;
  const dLon = (bLon - aLon) * DEG2RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * DEG2RAD) * Math.cos(bLat * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 駐輪場の空き（収容能力 − 止まっていた台数）が、放置台数以上か。負の空き（定員超過）もそのまま比べる。 */
export const vacancyCoversParked = (capacity: number, occupancy: number, parked: number): boolean =>
  capacity - occupancy >= parked;

/** ラベル用の名前。`stationNames`（主な駅が先頭）の先頭2つを「・」で並べ、3駅以上なら「ほか」を付ける。 */
export function shortNameOf(stationNames: readonly string[], fallback: string): string {
  if (stationNames.length === 0) return fallback;
  const head = stationNames.slice(0, 2).join('・');
  return stationNames.length > 2 ? `${head}ほか` : head;
}

/** 行に含まれる駅名を、通る路線が多い順（同数なら出現順）に並べる。 */
function stationNamesByImportance(rows: readonly StationRow[]): string[] {
  const lines = new Map<string, number>();
  const order: string[] = [];
  for (const r of rows) {
    for (const n of r.stationNames) {
      if (!lines.has(n)) {
        lines.set(n, 0);
        order.push(n);
      }
    }
    for (const m of r.geo?.matched ?? []) {
      if (lines.has(m.name)) lines.set(m.name, Math.max(lines.get(m.name)!, m.lines.length));
    }
  }
  // Array.prototype.sort は安定なので、同数は出現順のまま
  return order.sort((a, b) => lines.get(b)! - lines.get(a)!);
}

/** `siteKey` ごとに行を合算する（台数0の場所も残す）。出現順を保つ。 */
function groupBySiteKey(rows: readonly StationRow[]): StationSite[] {
  const groups = new Map<string, StationRow[]>();
  for (const row of rows) {
    const g = groups.get(row.siteKey);
    if (g) g.push(row);
    else groups.set(row.siteKey, [row]);
  }
  const sites: StationSite[] = [];
  for (const [key, g] of groups) {
    let bicycles = 0;
    let capacity = 0;
    let occupancy = 0;
    let lat = 0;
    let lon = 0;
    let top = g[0]!;
    for (const r of g) {
      bicycles += r.parked.bicycle;
      capacity += r.capacity?.bicycle ?? 0;
      occupancy += r.occupancy?.bicycle ?? 0;
      lat += r.lat;
      lon += r.lon;
      if (r.parked.bicycle > top.parked.bicycle) top = r;
    }
    const names = stationNamesByImportance(g);
    sites.push({
      name: key,
      shortName: shortNameOf(names, key),
      municipality: top.municipality,
      lat: lat / g.length,
      lon: lon / g.length,
      bicycles,
      capacity,
      occupancy,
      vacancyCoversParked: vacancyCoversParked(capacity, occupancy, bicycles),
      stationNames: names,
    });
  }
  return sites;
}

const shareStationName = (a: StationSite, b: StationSite): boolean =>
  a.stationNames.some((n) => b.stationNames.includes(n));

/** 同じ駅名を含み、`maxDistanceM` 以内にある場所を1か所にまとめる。 */
export function mergeNearbySites(sites: readonly StationSite[], maxDistanceM: number): StationSite[] {
  const result: StationSite[] = [];
  const used = new Array<boolean>(sites.length).fill(false);
  for (let i = 0; i < sites.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    // i と推移的に結びつく場所を集める（東京駅と国立競技場駅は2か所だが、念のため連鎖も扱う）
    const members: StationSite[] = [sites[i]!];
    for (let k = 0; k < members.length; k++) {
      const m = members[k]!;
      for (let j = i + 1; j < sites.length; j++) {
        if (used[j]) continue;
        const o = sites[j]!;
        if (shareStationName(m, o) && distanceM(m.lat, m.lon, o.lat, o.lon) <= maxDistanceM) {
          used[j] = true;
          members.push(o);
        }
      }
    }
    result.push(members.length === 1 ? members[0]! : combine(members));
  }
  return result;
}

function combine(members: readonly StationSite[]): StationSite {
  let top = members[0]!;
  let bicycles = 0;
  let capacity = 0;
  let occupancy = 0;
  for (const m of members) {
    bicycles += m.bicycles;
    capacity += m.capacity;
    occupancy += m.occupancy;
    if (m.bicycles > top.bicycles) top = m;
  }
  // 位置は台数で重み付けした平均（全体が0台のときは単純な平均）
  let lat = 0;
  let lon = 0;
  let weight = 0;
  for (const m of members) {
    const w = bicycles > 0 ? m.bicycles : 1;
    lat += m.lat * w;
    lon += m.lon * w;
    weight += w;
  }
  const names: string[] = [];
  for (const m of [top, ...members.filter((x) => x !== top)]) {
    for (const n of m.stationNames) if (!names.includes(n)) names.push(n);
  }
  return {
    name: top.name,
    shortName: top.shortName,
    municipality: top.municipality,
    lat: lat / weight,
    lon: lon / weight,
    bicycles,
    capacity,
    occupancy,
    vacancyCoversParked: vacancyCoversParked(capacity, occupancy, bicycles),
    stationNames: names,
  };
}

/**
 * 駅の行から、場所ごとの放置自転車の台数を求める。
 * 返す配列は台数の多い順（同数なら入力の順）。
 */
export function aggregateStationSites(rows: readonly StationRow[], options: AggregateOptions = {}): StationSite[] {
  const merged = mergeNearbySites(groupBySiteKey(rows), options.mergeDistanceM ?? DEFAULT_MERGE_DISTANCE_M);
  const kept = options.dropEmpty === false ? merged : merged.filter((s) => s.bicycles > 0);
  // Array.prototype.sort は安定なので、同数は入力の順のまま
  return kept.sort((a, b) => b.bicycles - a.bicycles);
}

/** 駐輪場の空きの数え方の結果。 */
export interface VacancyCount {
  /** 放置自転車が1台以上ある（行または場所の）数。 */
  withParked: number;
  /** そのうち、駐輪場の空きが放置台数以上のもの。 */
  enough: number;
}

/**
 * `stations.json` の行の単位で数える（台本の「530駅のうち425駅」）。放置自転車が1台以上ある行のうち、
 * 駐輪場の空き（収容能力 − 止まっていた台数）が放置台数以上のものを数える。
 */
export function countVacancyByRow(rows: readonly StationRow[]): VacancyCount {
  let withParked = 0;
  let enough = 0;
  for (const r of rows) {
    if (r.parked.bicycle < 1) continue;
    withParked++;
    if (vacancyCoversParked(r.capacity?.bicycle ?? 0, r.occupancy?.bicycle ?? 0, r.parked.bicycle)) enough++;
  }
  return { withParked, enough };
}

/** 場所（柱）の単位で数える。場所の柱の色分けと同じ判定。 */
export function countVacancyBySite(sites: readonly StationSite[]): VacancyCount {
  let withParked = 0;
  let enough = 0;
  for (const s of sites) {
    if (s.bicycles < 1) continue;
    withParked++;
    if (s.vacancyCoversParked) enough++;
  }
  return { withParked, enough };
}

/** 場所の台数の合計。 */
export const totalBicycles = (sites: readonly StationSite[]): number =>
  sites.reduce((sum, s) => sum + s.bicycles, 0);

/** `stations.json` を読み、場所ごとに合算して返す（台数0を除き、台数の多い順）。 */
export async function loadStationSites(options: AggregateOptions = {}): Promise<StationSite[]> {
  const res = await fetch(assetUrl('data/bicycles/stations.json'));
  if (!res.ok) throw new Error(`stations.json の取得に失敗: ${res.status}`);
  const json = (await res.json()) as { stations: StationRow[] };
  return aggregateStationSites(json.stations, options);
}
