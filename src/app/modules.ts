/**
 * 台本の場面 id → 3D の中身（今は仮の表示）。本物の中身ができたら、ここの対応を差し替える。
 */
import { FACTS, PILES } from '../story/content/facts';
import { PLACES } from '../story/content/script';
import { assetUrl } from '../paths';
import { ConeModule, MarkersModule, PillarsModule, type PillarSpec } from './placeholders';
import type { SceneModuleFactory } from './sceneModule';

interface StationRow {
  name: string;
  stationNames: string[];
  lat: number;
  lon: number;
  parked: { bicycle: number };
  occupancy: { bicycle: number };
  capacity: { bicycle: number };
}

/** 柱を立てる駅（場面3・4）。 */
const PILLAR_STATIONS = ['東京', '新宿', '渋谷', '池袋', '上野', '秋葉原'] as const;

let stationsPromise: Promise<StationRow[]> | null = null;
function loadStations(): Promise<StationRow[]> {
  stationsPromise ??= fetch(assetUrl('data/bicycles/stations.json'))
    .then((r) => {
      if (!r.ok) throw new Error(`stations.json を読めません: ${r.status}`);
      return r.json() as Promise<{ stations: StationRow[] }>;
    })
    .then((d) => d.stations);
  return stationsPromise;
}

/** 駅名ごとに、その駅を含む行（複数駅の合算行を含む）を足し合わせる。位置は「◯◯駅」の行。 */
async function stationTotals(): Promise<{ name: string; lat: number; lon: number; parked: number; vacancy: number }[]> {
  const rows = await loadStations();
  return PILLAR_STATIONS.map((name) => {
    const hits = rows.filter((r) => r.stationNames.includes(name));
    const at = hits.find((r) => r.name === `${name}駅`) ?? hits[0];
    if (!at) throw new Error(`駅が見つかりません: ${name}`);
    let parked = 0;
    let vacancy = 0;
    for (const r of hits) {
      parked += r.parked.bicycle;
      vacancy += Math.max(r.capacity.bicycle - r.occupancy.bicycle, 0);
    }
    return { name, lat: at.lat, lon: at.lon, parked, vacancy };
  });
}

/**
 * 秋葉原の目印の並び: 電気街口の駅前広場で、注視点の東（駅舎の前）に南北に長い帯（77台×6列、約 58m×12m）。
 * 場面1・8 の地上のカメラ（注視点の西から東南東を向く）の正面に並ぶ。
 */
const AKIHABARA_FIELD = { rowAzimuthDeg: 165, perRow: 77, offsetEastM: 7, offsetNorthM: 10 } as const;

const PARKED_COLOR = 0xe8442e;
const VACANCY_COLOR = 0x2f7fd8;
/** 柱の高さ: 1台あたり 5m。一辺 450m。 */
const PILLAR_M_PER_BICYCLE = 5;
const PILLAR_WIDTH_M = 450;

export const SCENE_MODULES: Record<string, SceneModuleFactory> = {
  'akihabara-one': () =>
    new MarkersModule({ id: 'akihabara-one', ...PLACES.akihabaraSidewalk, count: 1, rowAzimuthDeg: 160 }),
  'akihabara-462': () =>
    new MarkersModule({
      id: 'akihabara-462',
      ...PLACES.akihabaraSidewalk,
      count: FACTS.akihabaraParked.value,
      ...AKIHABARA_FIELD,
    }),
  'tokyo-13394': () =>
    new PillarsModule({
      id: 'tokyo-13394',
      metersPerUnit: PILLAR_M_PER_BICYCLE,
      widthM: PILLAR_WIDTH_M,
      load: async () =>
        (await stationTotals()).map((s): PillarSpec => ({ name: s.name, lat: s.lat, lon: s.lon, value: s.parked, color: PARKED_COLOR })),
    }),
  'parking-vacancy': () =>
    new PillarsModule({
      id: 'parking-vacancy',
      metersPerUnit: PILLAR_M_PER_BICYCLE,
      widthM: PILLAR_WIDTH_M,
      load: async () =>
        (await stationTotals()).flatMap((s): PillarSpec[] => [
          { name: `${s.name}:放置`, lat: s.lat, lon: s.lon, value: s.parked, color: PARKED_COLOR },
          { name: `${s.name}:空き`, lat: s.lat, lon: s.lon, value: s.vacancy, color: VACANCY_COLOR, offsetEastM: PILLAR_WIDTH_M * 1.3 },
        ]),
    }),
  'removed-fy2024': () =>
    new ConeModule({ id: 'removed-fy2024', ...PLACES.tokyoPlaza, heightM: PILES.removedFY2024.heightM, diameterM: PILES.removedFY2024.diameterM }),
  'removed-15years': () =>
    new ConeModule({ id: 'removed-15years', ...PLACES.kokyoPlaza, heightM: PILES.removed15Years.heightM, diameterM: PILES.removed15Years.diameterM }),
  'after-removal': () =>
    new ConeModule({ id: 'after-removal', ...PLACES.tokyoPlaza, heightM: PILES.removedFY2024.heightM, diameterM: PILES.removedFY2024.diameterM }),
  'since-1990': () =>
    new MarkersModule({
      id: 'since-1990',
      ...PLACES.akihabaraSidewalk,
      count: FACTS.akihabaraParked.value,
      ...AKIHABARA_FIELD,
    }),
};
