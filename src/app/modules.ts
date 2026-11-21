/**
 * 台本の場面 id → 3D の中身。
 * 場面1・2・8 は秋葉原の自転車、場面3・4 は駅ごとの柱、場面5・6・7 は今は仮の表示（山に差し替える）。
 */
import { PILES } from '../story/content/facts';
import { PLACES } from '../story/content/script';
import { createAkihabaraModules } from './modules/akihabara/module';
import { createStationModuleFactories } from './modules/stations';
import { ConeModule } from './placeholders';
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
  'removed-fy2024': () =>
    new ConeModule({ id: 'removed-fy2024', ...PLACES.tokyoPlaza, heightM: PILES.removedFY2024.heightM, diameterM: PILES.removedFY2024.diameterM }),
  'removed-15years': () =>
    new ConeModule({ id: 'removed-15years', ...PLACES.shinjukuPark, heightM: PILES.removed15Years.heightM, diameterM: PILES.removed15Years.diameterM }),
  'after-removal': () =>
    new ConeModule({ id: 'after-removal', ...PLACES.tokyoPlaza, heightM: PILES.removedFY2024.heightM, diameterM: PILES.removedFY2024.diameterM }),
  'since-1990': AKIHABARA.all,
};
