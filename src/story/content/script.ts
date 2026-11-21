/**
 * 本編の台本（8場面）。本文の数値は facts.ts の定数から組み立てる。
 *
 * カメラは `StoryCameraKeyframe`（注視点・距離・方位・仰角）。高さと水平距離で考えた値は
 * `cameraFrom()` で距離・仰角に直す。`place` は場面の街並み（建物を読む区を選ぶ中心と半径）。
 * 俯瞰の場面は null（建物を読まず、航空写真の地面だけを見せる）。
 */
import { distanceForHeight } from '../cameraPath';
import type { StoryCameraKeyframe, StoryStat, StoryText } from '../types';
import {
  FACTS,
  FIRST_FISCAL_YEAR,
  FISCAL_YEAR,
  MANY_BICYCLES_THRESHOLD,
  PEAK_YEAR,
  PILES,
  STATION_RADIUS_M,
  SURVEY,
  type Fact,
} from './facts';
import { formatDecimal, formatJaCount } from './format';

/** 場面の街並みを読む範囲。 */
export interface ScriptPlace {
  lat: number;
  lon: number;
  /** この半径(m)に掛かる区の建物（白、テクスチャなし）を、画面上の見え方に応じた詳細度で読む。 */
  radiusM: number;
}

export interface ScriptScene {
  /** 場面の id（DOM の `data-stage-id`、3D の中身の差し込みにも使う）。 */
  id: string;
  text: StoryText;
  camera: StoryCameraKeyframe;
  freeOrbit?: boolean;
  /** 建物を読む中心と範囲。null は建物を読まない（俯瞰）。 */
  place: ScriptPlace | null;
}

/** 本文の地点（緯度経度は度）。スクリーンショットで実際の場所に合わせた値。 */
export const PLACES = {
  /** 秋葉原駅（駅別の表の位置。国土数値情報の駅の代表点）。 */
  akihabaraStation: { lat: 35.698439, lon: 139.774018 },
  /** 秋葉原駅 電気街口の駅前広場（総武線の高架の北、山手線の西）。場面1・2・8 の建物を読む中心。ここに最も近い路上から自転車を置き始める。 */
  akihabaraSidewalk: { lat: 35.698815, lon: 139.772664 },
  /**
   * 駅前の1台（置いた順の先頭。駅前広場の南の端、総武線の高架の前の壁際）。場面1・8 の注視点。
   * `src/app/modules/akihabara/layout.ts` の配置の結果の位置（tests/unit/akihabaraLayout.test.ts が一致を確かめる）。
   */
  akihabaraFirstBike: { lat: 35.698655, lon: 139.772652 },
  /**
   * 場面2 の注視点（電気街口の駅前広場の東の端）。462台は駅の西（電気街口）・東（中央改札口・昭和通り口）・南西の通りに
   * 広がる。PC 幅では本文カードが画面の左に出るので、西の塊がカードの右に、東の塊が画面の右端に入るよう、広がりの中心より西に置く。
   */
  akihabaraBikesView: { lat: 35.698845, lon: 139.772803 },
  /**
   * 23区の俯瞰の注視点。23区の中心（35.69, 139.75 付近）より少し西にずらし、PC 幅で左に出る本文カードの右側に
   * 新宿・渋谷・池袋から上野・秋葉原・東京までが入るようにした。
   */
  wards: { lat: 35.69, lon: 139.705 },
  /** 東京駅 丸の内口の駅前広場の中央。2024年度の撤去台数の山を置く。 */
  tokyoPlaza: { lat: 35.68163, lon: 139.76539 },
  /** 新宿中央公園の北側の開けた場所（都庁前）。15年の累計の山を置く。 */
  shinjukuPark: { lat: 35.6901, lon: 139.6893 },
  /** 東京都庁第一本庁舎。 */
  tochoFirstBuilding: { lat: 35.6895, lon: 139.69175 },
} as const;

/** 数値を本文の書き方にする（1万以上は「万」）。小数は facts の桁数どおり。 */
function n(f: Fact): string {
  return f.fractionDigits ? formatDecimal(f.value, f.fractionDigits) : formatJaCount(f.value);
}

/** 数値と単位。 */
function nu(f: Fact): string {
  return `${n(f)}${f.unit}`;
}

function stat(f: Fact, label: string): StoryStat {
  return { value: f.value, unit: f.unit, label, fractionDigits: f.fractionDigits };
}

/**
 * 高さ heightM(m)・注視点からの水平距離 horizontalM(m) の位置から、方位 azimuthDeg を向いて注視点を見るカメラ。
 * targetAltM は注視点の地表からの高さ(m)。
 */
export function cameraFrom(
  target: { lat: number; lon: number },
  o: { heightM: number; horizontalM: number; azimuthDeg: number; targetAltM?: number },
): StoryCameraKeyframe {
  const alt = o.targetAltM ?? 0;
  const dy = o.heightM - alt;
  const distance = Math.hypot(o.horizontalM, dy);
  const elevationDeg = (Math.atan2(dy, o.horizontalM) * 180) / Math.PI;
  return { target: { lat: target.lat, lon: target.lon, alt }, distance, azimuthDeg: o.azimuthDeg, elevationDeg };
}

const F = FACTS;
const P = PLACES;
const pile5 = PILES.removedFY2024;
const pile6 = PILES.removed15Years;

/** 場面1・8 の地上のカメラの方位（度）。駅前の1台の横向きの姿と、その奥に壁沿いに続く列が見える向き。 */
const AKIHABARA_GROUND_AZIMUTH_DEG = 250;
/**
 * 場面1・8 の注視点の地表からの高さ(m)。目の高さ（1.8m）より少し上を見て、自転車（高さ約1.1m）を画面の下寄りに置く。
 * スマートフォン幅では本文カードが画面の中ほどに出るので、自転車がカードの下に見えるようにするため。
 */
const AKIHABARA_GROUND_TARGET_ALT_M = 2.4;

/** 23区の俯瞰の高さ(m)と仰角(度)。 */
const WARDS_HEIGHT_M = 28_000;
const WARDS_ELEVATION_DEG = 60;

export const SCRIPT: readonly ScriptScene[] = [
  {
    id: 'akihabara-one',
    text: {
      heading: '秋葉原駅前の1台',
      paragraphs: [
        `${SURVEY.year}年${SURVEY.month}月、晴れた平日の午前${SURVEY.hour}時ごろ。都内の区市町村が、駅の周りに置かれたままの自転車を数えた。`,
        `駅からおよそ半径${formatJaCount(STATION_RADIUS_M)}メートル以内で、駐輪場以外の道路に置かれ、持ち主がすぐには動かせない状態。都はこれを『放置』として数えている。`,
      ],
      stat: { value: 1, unit: '台' },
    },
    // 駅前の1台を、東北東 7m の人の目の高さ（1.8m）から見る。自転車はほぼ南北向き（前輪が南の高架の壁へ）なので、
    // 西南西を向くと横向きの姿が見える。
    camera: cameraFrom(P.akihabaraFirstBike, { heightM: 1.8, horizontalM: 7, azimuthDeg: AKIHABARA_GROUND_AZIMUTH_DEG, targetAltM: AKIHABARA_GROUND_TARGET_ALT_M }),
    place: { ...P.akihabaraSidewalk, radiusM: 1500 },
  },
  {
    id: 'akihabara-462',
    text: {
      heading: `秋葉原、${formatJaCount(F.akihabaraParked.value)}台`,
      paragraphs: [
        `調査のとき、秋葉原駅の周りには${nu(F.akihabaraParked)}の自転車が放置されていた。都内の駅で最も多い。`,
        `駅の周りにあった自転車は${nu(F.akihabaraInflow)}。その${nu(F.akihabaraParkedShare)}が、駐輪場の外に置かれていた。`,
        `千代田区の自転車の放置率は${nu(F.chiyodaParkedRate)}で、都内の区市町村で最も高い。`,
      ],
      stat: stat(F.akihabaraParked, `${SURVEY.year}年${SURVEY.month}月、秋葉原駅周辺の放置自転車`),
    },
    // 462台は通りの壁際に並ぶので、低い角度で斜めから見ると多くが建物に隠れる。南の上空から急な角度（約65°）で見下ろす。
    camera: cameraFrom(P.akihabaraBikesView, { heightM: 260, horizontalM: 120, azimuthDeg: 10, targetAltM: 0 }),
    place: { ...P.akihabaraSidewalk, radiusM: 1500 },
  },
  {
    id: 'tokyo-13394',
    text: {
      heading: `都内の駅に${nu(F.totalParked)}`,
      paragraphs: [
        `この調査で数えられた放置自転車は、島しょを除く都内の駅の周りで、合わせて${nu(F.totalParked)}だった。`,
        `放置自転車があった駅は${n(F.stationsWithParked)}。${MANY_BICYCLES_THRESHOLD}台以上あった駅は${n(F.stationsWithManyParked)}。全体の${nu(F.wardsShare)}は23区の駅に集まっていた。`,
        `駅の周りにあった自転車${nu(F.totalInflow)}のうち、${nu(F.totalParkedRate)}にあたる。`,
      ],
      stat: stat(F.totalParked, `${SURVEY.year}年${SURVEY.month}月、島しょを除く都内の駅周辺の放置自転車`),
    },
    camera: {
      target: { ...P.wards, alt: 0 },
      distance: distanceForHeight(WARDS_HEIGHT_M, WARDS_ELEVATION_DEG),
      azimuthDeg: 0,
      elevationDeg: WARDS_ELEVATION_DEG,
    },
    place: null,
  },
  {
    id: 'parking-vacancy',
    text: {
      heading: '駐輪場には空きがあった',
      paragraphs: [
        `秋葉原駅周辺の駐輪場の収容能力は、自転車${nu(F.akihabaraCapacity)}。調査のときに止まっていたのは${nu(F.akihabaraOccupancy)}で、${nu(F.akihabaraVacancy)}が空いていた。`,
        `放置自転車があった${nu(F.stationsWithParked)}のうち${nu(F.stationsVacancyExceeds)}では、駐輪場の空きが放置自転車の台数を上回っていた。`,
        `都内の駅周辺の駐輪場は${nu(F.parkingLots)}、収容能力は${nu(F.parkingCapacity)}。調査のときに止まっていたのは${nu(F.parkingOccupancy)}だった。`,
      ],
      stat: stat(F.akihabaraVacancy, '秋葉原駅周辺の駐輪場の空き'),
    },
    camera: {
      target: { ...P.wards, alt: 0 },
      distance: distanceForHeight(WARDS_HEIGHT_M, WARDS_ELEVATION_DEG),
      azimuthDeg: 12,
      elevationDeg: WARDS_ELEVATION_DEG,
    },
    place: null,
  },
  {
    id: 'removed-fy2024',
    text: {
      heading: `1年間で${nu(F.removedFY2024)}`,
      paragraphs: [
        `調査で数えたのは、ある時刻の台数だ。区市町村は1年を通して放置自転車を撤去している。${FISCAL_YEAR}年度に撤去された自転車は${nu(F.removedFY2024)}。`,
        `1日あたり約${nu(F.removedPerDay)}。秋葉原駅の周りで数えた台数より多い自転車が、毎日運ばれていった計算になる。`,
        `撤去・保管・返還にかかった費用は約${nu(F.removalCost)}で、撤去1台あたり約${nu(F.removalCostPerBicycle)}。持ち主が引き取るときに払った返還手数料の収入は約${nu(F.returnFeeIncome)}だった。`,
      ],
      stat: stat(F.removedFY2024, `${FISCAL_YEAR}年度に撤去された自転車`),
    },
    camera: cameraFrom(P.tokyoPlaza, { heightM: 90, horizontalM: 320, azimuthDeg: 112, targetAltM: pile5.heightM * 0.4 }),
    place: { ...P.tokyoPlaza, radiusM: 1800 },
  },
  {
    id: 'removed-15years',
    text: {
      heading: `${FISCAL_YEAR - FIRST_FISCAL_YEAR + 1}年で${nu(F.removed15Years)}`,
      paragraphs: [
        `${FIRST_FISCAL_YEAR}年度から${FISCAL_YEAR}年度までの${FISCAL_YEAR - FIRST_FISCAL_YEAR + 1}年間に、都内で撤去された自転車は${nu(F.removed15Years)}。${FISCAL_YEAR}年度の撤去台数の約${nu(F.removed15YearsInYears)}にあたる。`,
        `新宿の都庁前、新宿中央公園に1つの山として積むと、高さはおよそ${formatJaCount(pile6.heightM)}メートル、裾の直径は約${formatJaCount(Math.round(pile6.diameterM / 10) * 10)}メートルになる。隣に立つ都庁第一本庁舎の高さは${nu(F.tochoHeight)}。`,
        `体積は約${nu(F.cumulativePileVolume)}。東京ドーム約${nu(F.cumulativePileDomes)}になる。`,
      ],
      stat: stat(F.removed15Years, `${FIRST_FISCAL_YEAR}〜${FISCAL_YEAR}年度に撤去された自転車の累計`),
    },
    camera: cameraFrom(P.shinjukuPark, { heightM: 200, horizontalM: 750, azimuthDeg: 80, targetAltM: pile6.heightM * 0.5 }),
    place: { ...P.shinjukuPark, radiusM: 2000 },
  },
  {
    id: 'after-removal',
    text: {
      heading: '撤去された自転車の行方',
      paragraphs: [
        `${FISCAL_YEAR}年度に持ち主へ返された自転車は${nu(F.returnedFY2024)}。撤去された自転車等のうち、返還されたのは${nu(F.returnRate)}だった。`,
        `区市町村が処分した自転車は${nu(F.disposedFY2024)}。このうち${nu(F.reusedFY2024)}は、自転車のまま売却や譲渡などで再び使われた。`,
        `再び使われた自転車のうち、${nu(F.reusedOverseas)}は国外向け、${nu(F.reusedDomestic)}は国内向けだった。残る${nu(F.reusedUnknown)}は行き先が分からない。`,
      ],
      stat: stat(F.returnRate, `返還率（${FISCAL_YEAR}年度、自転車と原付）`),
    },
    camera: cameraFrom(P.tokyoPlaza, { heightM: 95, horizontalM: 150, azimuthDeg: 75, targetAltM: pile5.heightM * 0.4 }),
    place: { ...P.tokyoPlaza, radiusM: 1800 },
  },
  {
    id: 'since-1990',
    text: {
      heading: `${PEAK_YEAR}年、${nu(F.peakParked1990)}`,
      paragraphs: [
        `都内の駅周辺の放置台数が最も多かったのは${PEAK_YEAR}年の${nu(F.peakParked1990)}。同じ数え方で${SURVEY.year}年を数えると${nu(F.sameMethodParked2025)}になる。`,
        `撤去された自転車は、${FIRST_FISCAL_YEAR}年度の${nu(F.removedFY2010)}から、${FISCAL_YEAR}年度は${nu(F.removedFY2024)}に減った。`,
        `都は${SURVEY.year}年度中に放置自転車を${nu(F.targetParked)}にする目標を掲げていた。${SURVEY.year}年${SURVEY.month}月の調査では${nu(F.totalParked)}だった。`,
      ],
      stat: stat(
        F.sameMethodParked2025,
        `${SURVEY.year}年。${PEAK_YEAR}年は${nu(F.peakParked1990)}（自転車・原付・自動二輪の計、当時の数え方）`,
      ),
    },
    camera: cameraFrom(P.akihabaraFirstBike, { heightM: 1.8, horizontalM: 7, azimuthDeg: AKIHABARA_GROUND_AZIMUTH_DEG, targetAltM: AKIHABARA_GROUND_TARGET_ALT_M }),
    freeOrbit: true,
    place: { ...P.akihabaraSidewalk, radiusM: 1500 },
  },
];
