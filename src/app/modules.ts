/**
 * 台本の場面 id → 3D の中身（今は仮の表示）。本物の中身ができたら、ここの対応を差し替える。
 */
import { FACTS, PILES } from '../story/content/facts';
import { PLACES } from '../story/content/script';
import { createStationModuleFactories } from './modules/stations';
import { ConeModule, MarkersModule } from './placeholders';
import type { SceneModuleFactory } from './sceneModule';

/**
 * 秋葉原の目印の並び: 電気街口の駅前広場で、注視点の東（駅舎の前）に南北に長い帯（77台×6列、約 58m×12m）。
 * 場面1・8 の地上のカメラ（注視点の西から東南東を向く）の正面に並ぶ。
 */
const AKIHABARA_FIELD = { rowAzimuthDeg: 165, perRow: 77, offsetEastM: 7, offsetNorthM: 10 } as const;

/** 場面3・4（都内の駅ごとの放置自転車）。2つの場面は同じ柱を共有する。 */
const STATIONS = createStationModuleFactories();

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
  'tokyo-13394': STATIONS['tokyo-13394'],
  'parking-vacancy': STATIONS['parking-vacancy'],
  'removed-fy2024': () =>
    new ConeModule({ id: 'removed-fy2024', ...PLACES.tokyoPlaza, heightM: PILES.removedFY2024.heightM, diameterM: PILES.removedFY2024.diameterM }),
  'removed-15years': () =>
    new ConeModule({ id: 'removed-15years', ...PLACES.shinjukuPark, heightM: PILES.removed15Years.heightM, diameterM: PILES.removed15Years.diameterM }),
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
