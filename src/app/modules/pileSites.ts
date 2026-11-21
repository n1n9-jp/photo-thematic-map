/** 本編の山（場面5・7 は東京駅前、場面6 は新宿）。 */
import { FACTS, PILES } from '../../story/content/facts';
import { PLACES } from '../../story/content/script';
import type { PileSiteSpec } from './pileModule';

export const PILE_SITES = {
  /** 2024年度の撤去台数を、東京駅丸の内口の駅前広場に。全台を詰める。 */
  year: {
    key: 'year',
    grid: PILES.removedFY2024.grid,
    ...PLACES.tokyoPlaza,
    count: FACTS.removedFY2024.value,
    mode: 'full',
    label: '東京駅前',
  },
  /** 2010〜2024年度の累計を、新宿中央公園（都庁前）に。表層だけを置く。 */
  fifteenYears: {
    key: 'fifteenYears',
    grid: PILES.removed15Years.grid,
    ...PLACES.shinjukuPark,
    count: FACTS.removed15Years.value,
    mode: 'surface',
    label: '新宿',
  },
} as const satisfies Record<string, PileSiteSpec>;
