/** 焼き込む地区。 */
import type { GridName } from '../../src/data/grids';

export interface District {
  name: GridName;
  label: string;
  /** 格子の中心。 */
  lat: number;
  lon: number;
  /** 一辺(m)。 */
  size: number;
  cellSize: number;
  /** 照合する既知の建物（名前の一部と、建物の上の点）。 */
  landmarks: { name: string; lat: number; lon: number }[];
}

/** 範囲にかかる可能性のある区。実際に読むかはタイルセットの範囲で決める。 */
export const CANDIDATE_CITIES = ['千代田区', '中央区', '台東区', '文京区', '港区'];

const MARUNOUCHI_LANDMARKS = [
  { name: '丸の内ビルディング', lat: 35.68106, lon: 139.76381 },
  { name: '新丸の内ビルディング', lat: 35.6826, lon: 139.7643 },
  { name: 'JPタワー', lat: 35.67966, lon: 139.76487 },
  { name: '東京駅丸の内駅舎（中央部）', lat: 35.68124, lon: 139.76616 },
  { name: '丸の内パークビルディング', lat: 35.67901, lon: 139.76311 },
  { name: '東京ビルTOKIA', lat: 35.67893, lon: 139.7653 },
  { name: 'ノースタワー', lat: 35.6822, lon: 139.7695 },
];

export const DISTRICTS: District[] = [
  {
    name: 'akihabara',
    label: '秋葉原駅',
    lat: 35.698439,
    lon: 139.774018,
    size: 700,
    cellSize: 1,
    landmarks: [
      { name: '秋葉原UDX', lat: 35.70033, lon: 139.77251 },
      { name: '秋葉原ダイビル', lat: 35.69915, lon: 139.77283 },
      { name: '富士ソフト秋葉原ビル', lat: 35.69836, lon: 139.77465 },
    ],
  },
  {
    name: 'marunouchi',
    label: '東京駅丸の内口',
    lat: 35.6814,
    lon: 139.766,
    size: 700,
    cellSize: 1,
    landmarks: MARUNOUCHI_LANDMARKS,
  },
  {
    name: 'gaien',
    label: '皇居外苑',
    lat: 35.68,
    lon: 139.758,
    size: 1400,
    cellSize: 1,
    landmarks: MARUNOUCHI_LANDMARKS,
  },
];
