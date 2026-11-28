/**
 * 街の上に出す地名（案内の文字）と、場面ごとに出す地名の一覧。
 *
 * 地名は駅のラベル（台数を示すデータ）とは別の、場所の手がかり。航空写真のない地面でも、どこを見ているかが分かるように、
 * 場面の画面に入る駅・地区・川・道路・目印の名前を選ぶ。座標は緯度経度（度、世界測地系）で持ち、`latLonToLocal` で置く。
 *
 * 座標の根拠は国土地理院の地名検索（`GSI_SEARCH`。電子国土基本図の地名・住所の代表点）と、国土地理院の河川中心線・道路中心線
 * （ベクトルタイル `experimental_rvrcl`・`experimental_rdcl`）。
 * 地名ごとの検索語・採った点・地理院地図での確かめは `docs/design/place-labels/README.md` の表にある。
 * 川・道路の名前は、河川中心線・道路中心線の上の点に置いた。代表点が画面の外や山の下に来る地名は、同じ地物の見える部分の点に
 * ずらし、場面の画面（航空写真の地面）で地物の上にあることを確かめた。
 */

/** 国土地理院の地名検索 API（q に地名を入れる）。 */
export const GSI_SEARCH = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';

/**
 * 地名の種類。見た目と置き方が変わる。
 * - water: 川・湾（墨の淡い色、字間を広く）
 * - area: 地区・公園などの広がり（地点を中心に置く）
 * - road: 道路（地点を中心に置く、小さめ）
 * - point: 駅・建物・橋（小さな丸の印を地点に付け、文字は印の横）
 */
export type PlaceKind = 'water' | 'area' | 'road' | 'point';

/**
 * 地名の段階。カメラの高さ（真下の地表から）に応じて出す段階を変える（`PLACE_TIER_HEIGHTS`）。
 * - region: 東京全体を見渡す俯瞰の目印（湾・大きな川・皇居・空港）
 * - district: 地区の名前・大きな駅や建物
 * - local: 寄ったときの近くの名前（通り・橋・駅の出口）
 */
export type PlaceTier = 'region' | 'district' | 'local';

export interface PlaceName {
  /** 表示する名前。 */
  name: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  tier: PlaceTier;
  /** 地点の地表からの高さ(m)。建物の上端に付けるとき（都庁・駅舎の屋根）。既定 0。 */
  heightM?: number;
  /**
   * 置き場所のほかの候補（川の水面の別の点など）。地点の周りが柱やほかの地名で埋まっているとき、順に試す。
   */
  alternatives?: readonly { lat: number; lon: number }[];
}

/** 段階ごとの、出すカメラの高さ(m)の範囲（真下の地表から）。下限を含み、上限を含まない。 */
export const PLACE_TIER_HEIGHTS: Record<PlaceTier, { min: number; max: number }> = {
  region: { min: 2500, max: Number.POSITIVE_INFINITY },
  district: { min: 20, max: 8000 },
  local: { min: 0, max: 2000 },
};

/** 地名の一覧（座標の根拠は docs/design/place-labels/README.md）。 */
export const PLACE_NAMES = {
  // --- 東京全体の俯瞰（場面3・4）
  tokyoBay: { name: '東京湾', lat: 35.585, lon: 139.84, kind: 'water', tier: 'region' },
  // 川は、国土地理院の河川中心線（rivCode 隅田川 30202010595・荒川 30202001166・多摩川 30202011909）の上の点
  sumida: {
    name: '隅田川',
    lat: 35.717102,
    lon: 139.80635,
    kind: 'water',
    tier: 'region',
    alternatives: [
      { lat: 35.7, lon: 139.7927 },
      { lat: 35.728752, lon: 139.809801 },
    ],
  },
  arakawa: {
    name: '荒川',
    lat: 35.7,
    lon: 139.85666,
    kind: 'water',
    tier: 'region',
    alternatives: [
      { lat: 35.68, lon: 139.84882 },
      { lat: 35.725, lon: 139.83602 },
      { lat: 35.66, lon: 139.84581 },
      { lat: 35.745, lon: 139.81958 },
    ],
  },
  tama: {
    name: '多摩川',
    lat: 35.58,
    lon: 139.67084,
    kind: 'water',
    tier: 'region',
    alternatives: [
      { lat: 35.6, lon: 139.64044 },
      { lat: 35.56, lon: 139.68415 },
    ],
  },
  kokyo: { name: '皇居', lat: 35.684627, lon: 139.752032, kind: 'area', tier: 'region' },
  haneda: { name: '羽田空港', lat: 35.552529, lon: 139.779318, kind: 'area', tier: 'region' },

  // --- 秋葉原（場面1・2・8）
  akihabaraStation: { name: '秋葉原駅', lat: 35.698336, lon: 139.773169, kind: 'point', tier: 'district' },
  /** 場面1（地上の目線、西向き）で、駅前の1台の奥（西へ約 12m）の広場の地面に置く。 */
  denkigaiPlaza: { name: '電気街口 駅前広場', lat: 35.698655, lon: 139.772519, kind: 'area', tier: 'local' },
  denkigaiExit: { name: '電気街口', lat: 35.698815, lon: 139.772664, kind: 'point', tier: 'local' },
  // 線路の高架（航空写真がなくても形で分かる目印）。画面上の位置から求め、航空写真の線路の上にあることを確かめた点
  sobuLine: {
    name: '総武線',
    lat: 35.69853,
    lon: 139.77209,
    kind: 'road',
    tier: 'local',
    heightM: 18,
    alternatives: [{ lat: 35.6983, lon: 139.77494 }],
  },
  yamanoteLine: {
    name: '山手線・京浜東北線',
    lat: 35.69929,
    lon: 139.77343,
    kind: 'road',
    tier: 'local',
    heightM: 8,
    alternatives: [{ lat: 35.69776, lon: 139.77309 }],
  },
  kandaRiver: { name: '神田川', lat: 35.696917, lon: 139.776025, kind: 'water', tier: 'local' },
  manseiBridge: { name: '万世橋', lat: 35.69725, lon: 139.771, kind: 'point', tier: 'local' },
  chuoDori: { name: '中央通り', lat: 35.7, lon: 139.771413, kind: 'road', tier: 'local' },
  showaDori: { name: '昭和通り', lat: 35.699499, lon: 139.775365, kind: 'road', tier: 'local' },
  sotokanda: { name: '外神田', lat: 35.7005, lon: 139.7695, kind: 'area', tier: 'district' },
  sakumacho: { name: '神田佐久間町', lat: 35.698, lon: 139.7775, kind: 'area', tier: 'district' },
  iwamotocho: { name: '岩本町', lat: 35.693526, lon: 139.776933, kind: 'area', tier: 'district' },

  // --- 丸の内（場面5・7）
  /**
   * 駅舎の中央玄関の屋根。山に隠れるときは、北寄り・南寄りの屋根とドームに置く（国土地理院の写真で、中央玄関・ドームの位置を確かめた点。
   * 台本の `MARUNOUCHI_STATION`〔35.68124, 139.76695〕は駅舎の東のホームの上に当たるので使わない）。
   */
  tokyoStation: {
    name: '東京駅 丸の内駅舎',
    lat: 35.681327,
    lon: 139.766307,
    kind: 'point',
    tier: 'district',
    heightM: 24,
    alternatives: [
      // 中央玄関から北と南へ約 45m の屋根（北と南のドームを結ぶ線の上）と、ドーム
      { lat: 35.681722, lon: 139.766199 },
      { lat: 35.680932, lon: 139.765932 },
      { lat: 35.682294, lon: 139.766393 },
      { lat: 35.680534, lon: 139.765797 },
    ],
  },
  /** 駅前広場から皇居へ向かう通り。場面5・7 のカメラは通りの上にいるので、カメラの前（駅前広場の西の端）に置く。 */
  gyokoDori: { name: '行幸通り', lat: 35.68165, lon: 139.765, kind: 'road', tier: 'local' },
  marunouchi: { name: '丸の内', lat: 35.680023, lon: 139.763443, kind: 'area', tier: 'district' },
  otemachi: { name: '大手町', lat: 35.688068, lon: 139.763931, kind: 'area', tier: 'district' },
  yurakucho: { name: '有楽町', lat: 35.674484, lon: 139.760544, kind: 'area', tier: 'district' },
  yaesu: { name: '八重洲', lat: 35.682251, lon: 139.770966, kind: 'area', tier: 'district' },
  kokyoGaien: { name: '皇居外苑', lat: 35.679944, lon: 139.758466, kind: 'area', tier: 'district' },

  // --- 新宿（場面6）
  /** 公園の北側は山が覆うので、南側（山の手前の木立）に置く。 */
  shinjukuPark: {
    name: '新宿中央公園',
    lat: 35.6878,
    lon: 139.6903,
    kind: 'area',
    tier: 'district',
    alternatives: [{ lat: 35.6885, lon: 139.6893 }],
  },
  tocho: { name: '東京都庁', lat: 35.6895, lon: 139.69175, kind: 'point', tier: 'district', heightM: 243 },
  shinjukuStation: { name: '新宿駅', lat: 35.689598, lon: 139.699543, kind: 'point', tier: 'district' },
  /** 公園の北の高層ビル（西新宿六丁目）。 */
  nishiShinjuku: { name: '西新宿', lat: 35.693424, lon: 139.690964, kind: 'area', tier: 'district' },
  nakanoSakaue: { name: '中野坂上', lat: 35.697786, lon: 139.683056, kind: 'point', tier: 'district' },
  omeKaido: { name: '青梅街道', lat: 35.695424, lon: 139.689708, kind: 'road', tier: 'local' },
  yamateDori: { name: '山手通り', lat: 35.69, lon: 139.68172, kind: 'road', tier: 'local' },
} as const satisfies Record<string, PlaceName>;

export type PlaceId = keyof typeof PLACE_NAMES;

const AKIHABARA: readonly PlaceId[] = [
  'akihabaraStation',
  'sobuLine',
  'yamanoteLine',
  'kandaRiver',
  'chuoDori',
  'showaDori',
  'manseiBridge',
  'sotokanda',
  'sakumacho',
  'iwamotocho',
  'denkigaiExit',
];
const WARDS: readonly PlaceId[] = ['tokyoBay', 'kokyo', 'sumida', 'arakawa', 'tama', 'haneda'];
const MARUNOUCHI: readonly PlaceId[] = ['tokyoStation', 'gyokoDori', 'yaesu', 'otemachi', 'marunouchi', 'yurakucho', 'kokyoGaien'];

/**
 * 場面 id → 出す地名（先頭ほど優先。重なるときは先頭の地名を残す）。選んだ理由は docs/design/place-labels/README.md。
 */
export const SCENE_PLACE_NAMES: Readonly<Record<string, readonly PlaceId[]>> = {
  'akihabara-one': ['denkigaiPlaza'],
  'akihabara-462': AKIHABARA,
  'tokyo-13394': WARDS,
  'parking-vacancy': WARDS,
  'removed-fy2024': MARUNOUCHI,
  'removed-15years': ['shinjukuPark', 'tocho', 'nishiShinjuku', 'shinjukuStation', 'nakanoSakaue', 'omeKaido', 'yamateDori'],
  'after-removal': MARUNOUCHI,
  'since-1990': AKIHABARA,
};

/** 場面の地名（id 付き）。 */
export function placesForScene(sceneId: string): (PlaceName & { id: PlaceId })[] {
  return (SCENE_PLACE_NAMES[sceneId] ?? []).map((id) => ({ id, ...PLACE_NAMES[id] }));
}
