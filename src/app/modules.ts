/**
 * 台本の場面 id → 3D の中身。
 * 場面1・2・8 は秋葉原の自転車、場面3・4 は駅ごとの柱、場面5・6・7 は自転車の山。
 */
import { createAkihabaraModules } from './modules/akihabara/module';
import { PileModule } from './modules/pileModule';
import { PILE_SITES } from './modules/pileSites';
import { createStationModuleFactories } from './modules/stations';
import type { SceneModuleFactory } from './sceneModule';

/** 秋葉原駅の周りの 462台（場面1・2・8 で共有する）。 */
const AKIHABARA = createAkihabaraModules();

/** 場面3・4（都内の駅ごとの放置自転車）。2つの場面は同じ柱を共有する。 */
const STATIONS = createStationModuleFactories();

export const SCENE_MODULES: Record<string, SceneModuleFactory> = {
  'akihabara-one': AKIHABARA.one,
  'akihabara-462': AKIHABARA.grow,
  'tokyo-13394': STATIONS['tokyo-13394'],
  'parking-vacancy': STATIONS['parking-vacancy'],
  'removed-fy2024': () => new PileModule({ id: 'removed-fy2024', site: PILE_SITES.year, growth: 'grow' }),
  'removed-15years': () => new PileModule({ id: 'removed-15years', site: PILE_SITES.fifteenYears, growth: 'grow' }),
  'after-removal': () => new PileModule({ id: 'after-removal', site: PILE_SITES.year, growth: 'full' }),
  'since-1990': AKIHABARA.all,
};
