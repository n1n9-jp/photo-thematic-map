/**
 * 本文に出てくる数値と、その出典。数値の訂正はこのファイルの1か所で済むようにする。
 * 本文（script.ts）はここから組み立てる。`source` は資料名（URL は「データと方法」の節で示す）。
 */

export interface Fact {
  value: number;
  unit: string;
  /** 出典の資料名。本作で計算した値は `CALC` で始め、計算の元を書く。 */
  source: string;
  /** 小数点以下の桁数（本文・大きな数値の表示に使う）。既定 0。 */
  fractionDigits?: number;
  /** 数え方・範囲などの注記。 */
  note?: string;
}

/** 出典の資料名。 */
export const SOURCES = {
  /** 東京都「駅前放置自転車等の現況と対策－令和７年度調査－」について －調査結果の概要－ */
  summary: '「駅前放置自転車等の現況と対策－令和７年度調査－」について －調査結果の概要－',
  /** 東京都 駅前放置自転車等の現況と対策 －令和７年度調査－（全文） */
  full: '駅前放置自転車等の現況と対策 －令和７年度調査－（全文）',
  /** 駅別の表（Excel） */
  stations: '駅前放置自転車等の現況と対策 －令和７年度調査－ （4）駅別放置自転車、原動機付自転車及び自動二輪車の状況（Excel）',
  /** 東京都 報道発表 */
  press: '東京都 報道発表「駅前放置自転車等の現況と対策」調査結果（2026年3月26日）',
} as const;

/** 本作で計算した値の出典の書き出し。 */
export const CALC = '本作の計算';

const fact = (value: number, unit: string, source: string, extra: Partial<Fact> = {}): Fact => ({
  value,
  unit,
  source,
  ...extra,
});

/** 調査の時点（令和7年度調査）。 */
export const SURVEY = { year: 2025, month: 10, hour: 11 } as const;
/** 撤去台数などの年度。 */
export const FISCAL_YEAR = 2024;
/** 累計の始まりの年度。 */
export const FIRST_FISCAL_YEAR = 2010;
/** 放置台数が最も多かった年。 */
export const PEAK_YEAR = 1990;
/** 「駅の周り」の目安の半径(m)。 */
export const STATION_RADIUS_M = 500;
/** 「100台以上あった駅」の閾値。 */
export const MANY_BICYCLES_THRESHOLD = 100;

/**
 * 山の大きさ。本編と同じ計算（`src/scene/pileScene/compute.ts` の computePileScene、1台あたりのかさ 0.35m³、安息角 35°）を、
 * 街の高さ格子（public/data/grids/）で行った結果（`scripts/bake/pileFacts.ts` で求めた値。`tests/unit/pileFacts.test.ts` が照合する）。
 * - removedFY2024: 2024年度の撤去台数を東京駅丸の内口の駅前広場に積んだ山（全台を詰める）。
 * - removed15Years: 15年の累計を新宿中央公園（都庁前）に積んだ山（表層だけを置く）。
 * - heightM: 頂上の、山を積んだ地点の地表からの高さ(m)。
 * - diameterM: 裾の直径(m)。山が覆う範囲（厚さ 5cm 以上）の面積と同じ面積の円の直径。
 */
export const PILES = {
  removedFY2024: {
    grid: 'marunouchi',
    heightM: 37.3,
    diameterM: 86,
    areaM2: 5_818,
    source: `${CALC}（堆積計算 src/scene/pileScene/compute.ts）`,
  },
  removed15Years: {
    grid: 'shinjuku',
    heightM: 98.9,
    diameterM: 278,
    areaM2: 60_740,
    source: `${CALC}（堆積計算 src/scene/pileScene/compute.ts）`,
  },
} as const;

export const FACTS = {
  // --- 秋葉原駅（場面1・2・4）
  akihabaraParked: fact(462, '台', SOURCES.stations, { note: '秋葉原駅の行、自転車' }),
  akihabaraInflow: fact(966, '台', SOURCES.stations, { note: '秋葉原駅の行、自転車の乗入台数' }),
  akihabaraParkedShare: fact(47.8, '％', `${CALC}（462 ÷ 966）`, { fractionDigits: 1 }),
  chiyodaParkedRate: fact(46.5, '％', SOURCES.full, { fractionDigits: 1, note: '区市町村別の自転車の放置率' }),
  akihabaraCapacity: fact(782, '台', SOURCES.stations, { note: '秋葉原駅の行、自転車の収容能力' }),
  akihabaraOccupancy: fact(504, '台', SOURCES.stations, { note: '秋葉原駅の行、自転車の実収容台数' }),
  akihabaraVacancy: fact(278, '台分', `${CALC}（782 − 504）`),

  // --- 都内全体（場面3・4）
  totalParked: fact(13_394, '台', SOURCES.summary, { note: '島しょを除く。自転車のみ' }),
  stationsWithParked: fact(530, '駅', SOURCES.full),
  stationsWithManyParked: fact(29, '駅', SOURCES.full),
  wardsShare: fact(94, '％', SOURCES.full, { note: '23区の駅の放置自転車が全体に占める割合' }),
  totalInflow: fact(545_983, '台', SOURCES.summary),
  totalParkedRate: fact(2.5, '％', SOURCES.summary, { fractionDigits: 1 }),
  stationsVacancyExceeds: fact(425, '駅', `${CALC}（駅別の表の収容能力 − 実収容台数 と放置台数の比較）`, {
    note: '駅別の表の行の単位。放置自転車が1台以上ある530行のうち、収容能力 − 実収容台数 ≧ 放置台数 の行。柱は同じ場所の行をまとめた489か所で、その単位では398か所（単体テストで固定）',
  }),
  parkingLots: fact(2_943, 'か所', SOURCES.summary),
  parkingCapacity: fact(897_461, '台', SOURCES.summary),
  parkingOccupancy: fact(549_491, '台', SOURCES.summary),

  // --- 撤去（場面5）
  removedFY2024: fact(187_262, '台', SOURCES.full, { note: '2024年度、自転車のみ' }),
  yearPileHeight: fact(Math.round(PILES.removedFY2024.heightM), 'メートル', PILES.removedFY2024.source, { note: '頂上の地表からの高さ' }),
  yearPileDiameter: fact(Math.round(PILES.removedFY2024.diameterM / 10) * 10, 'メートル', PILES.removedFY2024.source, { note: '裾の直径、10m 単位' }),
  removedPerDay: fact(513, '台', `${CALC}（187,262 ÷ 365）`),
  removalCost: fact(53.7, '億円', SOURCES.summary, { fractionDigits: 1 }),
  removalCostPerBicycle: fact(28_000, '円', `${CALC}（53.7億円 ÷ 撤去台数 18万8,561台（原付を含む）、千円未満を丸め）`),
  returnFeeIncome: fact(4.3, '億円', SOURCES.full, { fractionDigits: 1 }),

  // --- 15年の累計（場面6）
  removed15Years: fact(5_798_477, '台', SOURCES.full, { note: '2010〜2024年度の撤去台数（自転車）の合計' }),
  removed15YearsInYears: fact(31, '年分', `${CALC}（579万8,477 ÷ 18万7,262）`),
  cumulativePileHeight: fact(Math.round(PILES.removed15Years.heightM), 'メートル', PILES.removed15Years.source, { note: '頂上の地表からの高さ' }),
  cumulativePileDiameter: fact(Math.round(PILES.removed15Years.diameterM / 10) * 10, 'メートル', PILES.removed15Years.source, { note: '裾の直径（覆う範囲と同じ面積の円）、10m 単位' }),
  cumulativePileVolume: fact(2_030_000, '立方メートル', `${CALC}（堆積計算 src/sim/pile.ts）`),
  tochoHeight: fact(243, 'メートル', '東京都財務局の資料（都庁第一本庁舎の高さ、最高部 243.4m）'),
  cumulativePileDomes: fact(1.6, '杯分', `${CALC}（東京ドームの容積 124万立方メートル）`, { fractionDigits: 1 }),

  // --- 撤去のあと（場面7）
  returnedFY2024: fact(120_509, '台', SOURCES.full, { note: '2024年度、自転車のみ' }),
  returnRate: fact(64.4, '％', SOURCES.full, { fractionDigits: 1, note: '2024年度、自転車と原付' }),
  disposedFY2024: fact(67_113, '台', SOURCES.full),
  reusedFY2024: fact(51_431, '台', SOURCES.full, { note: '売却・譲渡など、自転車のまま再び使われたもの' }),
  reusedOverseas: fact(32_565, '台', SOURCES.full),
  reusedDomestic: fact(12_508, '台', SOURCES.full),
  reusedUnknown: fact(6_358, '台', SOURCES.full),

  // --- 推移（場面8）
  peakParked1990: fact(242_760, '台', SOURCES.press, { note: '自転車・原付・自動二輪の計、当時の数え方' }),
  sameMethodParked2025: fact(4_263, '台', SOURCES.full, { note: '1990年と同じ数え方' }),
  removedFY2010: fact(683_292, '台', SOURCES.full),
  targetParked: fact(15_000, '台以下', SOURCES.press, { note: '2025年度中の目標' }),
} as const satisfies Record<string, Fact>;

