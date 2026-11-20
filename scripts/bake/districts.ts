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
  landmarks: { name: string; lat: number; lon: number; published?: { height: number; source: string } }[];
}

/** 範囲にかかる可能性のある区。実際に読むかはタイルセットの範囲で決める。 */
export const CANDIDATE_CITIES = ['千代田区', '中央区', '台東区', '文京区', '港区', '新宿区', '渋谷区', '中野区'];

const MARUNOUCHI_LANDMARKS = [
  { name: '丸の内ビルディング', lat: 35.68106, lon: 139.76381, published: { height: 179.0, source: 'https://office.mec.co.jp/en/search/detail/011401/' } },
  { name: '新丸の内ビルディング', lat: 35.6826, lon: 139.7643, published: { height: 197.6, source: 'https://office.mec.co.jp/en/search/detail/011402/' } },
  { name: 'JPタワー', lat: 35.67966, lon: 139.76487, published: { height: 200.0, source: 'https://office.mec.co.jp/en/search/detail/011611/' } },
  { name: '東京駅丸の内駅舎（中央部）', lat: 35.68124, lon: 139.76616 },
  { name: '丸の内パークビルディング', lat: 35.67901, lon: 139.76311, published: { height: 170.0, source: 'https://office.mec.co.jp/en/search/detail/011418/' } },
  { name: '東京ビルTOKIA', lat: 35.67893, lon: 139.7653, published: { height: 164.0, source: 'https://office.mec.co.jp/en/search/detail/011417/' } },
  { name: 'ノースタワー', lat: 35.6822, lon: 139.7695, published: { height: 205.0, source: 'https://www.nikken.co.jp/ja/projects/transit_oriented_development/tokyo_station_yaesu_development_granroof_grantokyo_north_tower.html' } },
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
    name: 'shinjuku',
    label: '新宿中央公園・都庁前',
    // 公園（西側）と都庁・西新宿の超高層ビル群（東側）が入るよう、公園の中心より東寄りに置く。
    lat: 35.6895,
    lon: 139.6925,
    size: 1400,
    cellSize: 1,
    landmarks: [
      { name: '東京都庁第一本庁舎', lat: 35.6895, lon: 139.69175, published: { height: 243.0, source: 'オーケストレータの指定値（243m）' } },
      { name: '東京都庁第二本庁舎', lat: 35.68885, lon: 139.69085 },
      { name: '新宿パークタワー', lat: 35.68565, lon: 139.69075 },
      { name: '新宿三井ビル', lat: 35.6918, lon: 139.6955 },
      { name: '新宿センタービル', lat: 35.6915, lon: 139.6970 },
    ],
  },
];
