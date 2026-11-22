/**
 * 本編の台本（8場面）。本文の数値は facts.ts の定数から組み立てる。
 *
 * カメラは `StoryCameraKeyframe`（注視点・距離・方位・仰角）。高さと水平距離で考えた値は
 * `cameraFrom()` で距離・仰角に直す。`place` は場面の街並み（建物を読む区を選ぶ中心と半径）。
 * 俯瞰の場面は null（建物を読まず、航空写真の地面だけを見せる）。
 */
import { latLonToLocal } from '../../geo/enu';
import { distanceForHeight } from '../cameraPath';
import type { StoryCameraFit, StoryCameraKeyframe, StoryCameraView, StoryStat, StoryText } from '../types';
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
   * 駅前の1台（置いた順の先頭。駅前広場の南の端、総武線の高架の前の壁際）。場面1 の注視点。
   * `src/app/modules/akihabara/layout.ts` の配置の結果の位置（tests/unit/akihabaraLayout.test.ts が一致を確かめる）。
   */
  akihabaraFirstBike: { lat: 35.698655, lon: 139.772652 },
  /**
   * 23区の俯瞰の注視点。23区の489か所のうち23区内の駅（410か所）の緯度経度の範囲（東西 139.568〜139.898、南北 35.541〜35.815）の
   * 中央に近い。注視点は本文カードに覆われない範囲の中央に置かれる（`story/layout.ts`）ので、西にずらす必要はない。
   * 距離は `WARDS_FIT`（この範囲が覆われていない範囲に収まる距離）で決まるので、画面の縦横比によらず23区の全体が見える。
   */
  wards: { lat: 35.68, lon: 139.735 },
  /**
   * 東京駅 丸の内口の駅前広場。2024年度の撤去台数の山を置く地点（堆積計算が開けた地表に寄せた後の投入点。
   * 駅舎の中央から西へ約 110m、行幸通りの軸の上）。
   */
  tokyoPlaza: { lat: 35.681407, lon: 139.765932 },
  /** 新宿中央公園の北側の開けた場所（都庁前）。15年の累計の山を置く地点（同じく投入点）。 */
  shinjukuPark: { lat: 35.689996, lon: 139.689501 },
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

/**
 * 地点 p を、方位 azimuthDeg（北=0、東=90）へ distanceM(m) ずらした緯度経度。
 * 本文カードが PC 幅で画面の左に出るので、注視点を山の左（カメラの向きの左手）へずらして、山を画面の右に寄せるのに使う。
 */
export function offsetLatLon(p: { lat: number; lon: number }, azimuthDeg: number, distanceM: number): { lat: number; lon: number } {
  const a = (azimuthDeg * Math.PI) / 180;
  const R = 6_378_137;
  const dLat = ((distanceM * Math.cos(a)) / R) * (180 / Math.PI);
  const dLon = ((distanceM * Math.sin(a)) / (R * Math.cos((p.lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

const F = FACTS;
const P = PLACES;
const pile5 = PILES.removedFY2024;
const pile6 = PILES.removed15Years;

/**
 * 場面1: 駅前の1台を、東の少し上（目の高さより上）から見下ろす。自転車はほぼ南北向き（前輪が南の高架の壁へ）なので、
 * 西を向くと横向きの姿が見え、背景は高架の壁より駅前広場の地面が多くなる（地上の目線のままだと画面の大半が壁になった）。
 * 縦長の画面（スマートフォン）は画面の幅が狭いので、少し離れて、周りの広場と建物の足元も入れる。
 */
const SCENE1_VIEW = { azimuthDeg: 270, heightM: 2.2, horizontalM: 6, targetAltM: 1.0 } as const;
const SCENE1_PORTRAIT_VIEW = { azimuthDeg: 270, heightM: 2.5, horizontalM: 8, targetAltM: 1.2 } as const;

/**
 * 秋葉原の 462台の広がり。置いた順の先頭 k 台の凸包（自転車の長さの半分ほど外へ広げた多角形）を、凸包を囲む長方形の中心からの
 * 東・北へのずれ(m)で表す。`src/app/modules/akihabara/layout.ts` の配置の結果（tests/unit/akihabaraExtent.test.ts が、
 * 先頭 k 台がすべて多角形の中にあることを確かめる）。
 * 先頭の 21台は電気街口の駅前広場の周り（約 45m 四方）にあり、22台目で駅の東（中央改札口・昭和通り口）が加わって
 * 東西約 230m に広がる。
 */
export const AKIHABARA_EXTENTS = {
  k21: { count: 21, center: { lat: 35.698757, lon: 139.772635 }, hull: [[-22.6, 8.7], [-22.4, 8.1], [0.1, -13], [9.9, -12.7], [10.4, -12.5], [21.9, 9.9], [22.1, 10.5], [22.5, 12.3]] },
  k22: { count: 22, center: { lat: 35.698481, lon: 139.773684 }, hull: [[-117.6, 39.3], [-117.4, 38.7], [-96.4, 19.4], [117.6, -42.7], [-75.1, 42.9]] },
  k120: { count: 120, center: { lat: 35.69841, lon: 139.77372 }, hull: [[-131, 50.7], [-123.8, -33.9], [-122.1, -34.4], [-115.9, -36.2], [121.6, -51], [130.3, -41.3], [131.1, -35.5], [-78.4, 50.9], [-125.6, 51]] },
  k180: { count: 180, center: { lat: 35.698553, lon: 139.77371 }, hull: [[-133.4, 36], [-122.7, -49.9], [-112.8, -55.7], [122.7, -72.8], [133.3, -56.9], [133.1, -51.5], [18.7, 73.2], [17.1, 73.5], [13.4, 73.5], [-127.7, 55.9], [-127.8, 55.4]] },
  k330: { count: 330, center: { lat: 35.69853, lon: 139.773579 }, hull: [[-145.2, -30], [-101, -53.3], [134.5, -84.9], [145.1, -54.4], [144.9, -49], [30.7, 75.7], [29.1, 75.9], [21.1, 77], [11.1, 78], [-97.1, 85], [-114.8, 66.3], [-115, 65.8]] },
  k462: { count: 462, center: { lat: 35.698571, lon: 139.7735 }, hull: [[-152.3, -53.4], [-83.8, -91.3], [141.5, -92.1], [141.7, -91.6], [152.3, -58.9], [152.1, -53.5], [50.3, 90.6], [48.7, 91.5], [47.7, 92], [21.7, 92.8], [18, 92.8], [-86.9, 89], [-88.5, 88.5], [-107.6, 61.8]] },
} as const satisfies Record<string, AkihabaraExtent>;

export interface AkihabaraExtent {
  /** 先頭から何台目までの広がりか。 */
  count: number;
  center: { lat: number; lon: number };
  /** 凸包の頂点（中心からの東・北へのずれ(m)）。 */
  hull: readonly (readonly [number, number])[];
}

/**
 * 場面2 で 462台が増えきる進み具合（カメラが止まっている区間に対する割合）。
 * `src/app/modules/akihabara/module.ts` の GROW_END_OF_HOLD と同じ値（tests/unit/akihabaraExtent.test.ts が確かめる）。
 */
export const AKIHABARA_GROW_END = 0.85;
/** k 台目が現れる進み具合（カメラが止まっている区間に対する割合）。 */
export function akihabaraAtCount(k: number): number {
  return (AKIHABARA_GROW_END * (k - 1)) / (FACTS.akihabaraParked.value - 1);
}

function fitHull(e: AkihabaraExtent): StoryCameraFit {
  return { eastWestM: 0, northSouthM: 0, points: e.hull.map(([eastM, northM]) => ({ eastM, northM })) };
}

/** 上空から見下ろすカメラの向き。 */
interface AboveAngles {
  azimuthDeg: number;
  elevationDeg: number;
}

/**
 * 広がり e が本文カードに覆われていない範囲に収まる、最も近いカメラ（距離はカメラリグが画面の大きさから求める。`fit`）。
 * minDistanceM は「これより近づかない」下限。
 */
function akihabaraFit(e: AkihabaraExtent, a: AboveAngles, minDistanceM = 1): StoryCameraView {
  return { target: { ...e.center, alt: 0 }, distance: minDistanceM, azimuthDeg: a.azimuthDeg, elevationDeg: a.elevationDeg, fit: fitHull(e) };
}

/**
 * 場面2 の始まり: 電気街口の駅前広場を上から見る。自転車の全長が画面上で 12 CSS px 以上になる距離（下限 AKIHABARA_START_DISTANCE_M）で、
 * 先頭の 21台（駅前広場の周り）が収まる。場面1（西向き）からの方位の差は 150° 以内。
 */
const AKIHABARA_START: AboveAngles = { azimuthDeg: 300, elevationDeg: 65 };
const AKIHABARA_START_DISTANCE_M = 70;
/**
 * 場面2 の終わりと場面8: 462台の広がりが本文カードに覆われていない範囲に収まる、最も近い距離。方位と見下ろす角度は、
 * その距離で、建物にも本文カードにも隠れずに見える台数が最も多いもの（`tests/e2e/visibilityHelpers.ts` の測り方）。
 */
const AKIHABARA_END: AboveAngles = { azimuthDeg: 45, elevationDeg: 80 };
const AKIHABARA_END_PORTRAIT: AboveAngles = { azimuthDeg: 75, elevationDeg: 80 };

/** 場面2: 始まり（駅前広場）→ 22台目で駅の東が加わる前に引く → 増えるにつれて少しずつ引き、462台の広がりに合わせる。 */
const AKIHABARA_GROW: StoryCameraKeyframe = {
  ...akihabaraFit(AKIHABARA_EXTENTS.k21, AKIHABARA_START, AKIHABARA_START_DISTANCE_M),
  stops: [
    // 8台目までは駅前広場のまま
    { at: akihabaraAtCount(8), camera: akihabaraFit(AKIHABARA_EXTENTS.k21, AKIHABARA_START, AKIHABARA_START_DISTANCE_M) },
    ...[AKIHABARA_EXTENTS.k22, AKIHABARA_EXTENTS.k120, AKIHABARA_EXTENTS.k180, AKIHABARA_EXTENTS.k330, AKIHABARA_EXTENTS.k462].map((e) => ({
      at: akihabaraAtCount(e.count),
      camera: akihabaraFit(e, AKIHABARA_END),
      portrait: akihabaraFit(e, AKIHABARA_END_PORTRAIT),
    })),
  ],
};

/** 場面8: 場面2 の終わりと同じ構図。 */
const AKIHABARA_ALL: StoryCameraKeyframe = {
  ...akihabaraFit(AKIHABARA_EXTENTS.k462, AKIHABARA_END),
  portrait: akihabaraFit(AKIHABARA_EXTENTS.k462, AKIHABARA_END_PORTRAIT),
};

/**
 * 山の場面（5・6・7）のカメラは、方位・高さ・距離を何通りも試し、山の画素のうち建物に隠れずに見える割合（`tests/e2e/visibilityHelpers.ts`）、
 * 山の頂上から裾までが画面に入るか、物差しの建物が一緒に入るかと、見た目で選んだ。本文カードが下寄せの配置（スマートフォン）は
 * 横幅が狭く、同じ距離では山の裾が画面からはみ出すので、別に決めた（`portrait`）。
 */
interface PileView {
  azimuthDeg: number;
  heightM: number;
  horizontalM: number;
  targetAltM: number;
  /** 注視点を、山の中心から左手（カメラの向きの左）へずらす距離(m)。PC 幅で山を本文カードの右に寄せる。 */
  shiftM: number;
}

/**
 * 場面5: 行幸通りの上（高さ約 34m、山の頂上とほぼ同じ高さ）から東南東（駅舎の方）を向く。山の後ろに丸の内駅舎（高さ約 35m）。
 * 地上近くから見上げる構図も試したが、街並みの建物と地面のタイルを地平線まで読むため描画が重く（建物だけで約 720 万三角形）、
 * スマートフォンで扱えないので、頂上の高さから水平に近く見る構図にした。PC 幅は山の 99% が隠れずに見える。
 * 縦長の画面では、同じ方位で倍ほど離れ、少し上（高さ 60m）から見て、山の裾までを画面の幅に収める（駅舎は山の後ろに見える）。
 */
const SCENE5_VIEW: PileView = { azimuthDeg: 105, heightM: 34, horizontalM: 165, targetAltM: pile5.heightM * 0.45, shiftM: 14 };
const SCENE5_PORTRAIT_VIEW: PileView = { azimuthDeg: 105, heightM: 60, horizontalM: 300, targetAltM: pile5.heightM * 0.45, shiftM: 0 };
/**
 * 場面7: 東京駅前の山に寄る。西北西の斜め上（高さ 70m）から、左に丸の内駅舎の北のドーム、右に山。以前の高さ 30m・水平 115m では
 * 山の右の裾が画面からはみ出した。北西（方位 125°）からも試したが、カメラのすぐ後ろに高層ビルがあり、場面の間を移るときに
 * そのビルの中を通ったので、後ろの空いた方位にした。縦長の画面では、北西からだと手前の建物の中にカメラが入るので、
 * 場面5 と同じ方位から、場面5 より近く・高く見る。
 */
const SCENE7_VIEW: PileView = { azimuthDeg: 115, heightM: 70, horizontalM: 150, targetAltM: pile5.heightM * 0.4, shiftM: 8 };
const SCENE7_PORTRAIT_VIEW: PileView = { azimuthDeg: 105, heightM: 80, horizontalM: 270, targetAltM: pile5.heightM * 0.4, shiftM: 0 };
/**
 * 場面6: 山の高さを都庁第一本庁舎（243m）と比べて感じる場面。見下ろす角度（俯角）を 30° 以下にして、山の頂上が背景に対して
 * 三角の輪郭に見え、都庁の上端から足元までが山の隣に入るようにする。距離は、山の裾と頂上、都庁の上端と足元が本文カードに
 * 覆われていない範囲に収まる距離（`fit`）。方位と俯角は、手前に高層ビルのない方位を何通りも試して選んだ:
 * 南南東の上空（初台・西新宿三丁目の低層の住宅地の上）から北北西を向くと、山の右に都庁が立ち、山の後ろは西新宿の高層ビル群になる。
 * 縦長の画面は、俯角 20° では手前のビルに山の裾が隠れたので 25°。
 * 以前の北西の上空（高さ 550m、俯角約 40°）からは、山が平たい円盤に見えた。
 */
const SCENE6_ANGLES = { azimuthDeg: 345, elevationDeg: 20 } as const;
const SCENE6_PORTRAIT_ANGLES = { azimuthDeg: 345, elevationDeg: 25 } as const;
/** 場面6 の注視点の地表からの高さ(m)（山の高さの 6 割。山と都庁の上端の間）。 */
const SCENE6_TARGET_ALT_M = pile6.heightM * 0.6;

/** 地点 a から地点 b への東・北へのずれ(m)。 */
function offsetM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { eastM: number; northM: number } {
  const pa = latLonToLocal({ ...a, alt: 0 });
  const pb = latLonToLocal({ ...b, alt: 0 });
  return { eastM: pb.x - pa.x, northM: -(pb.z - pa.z) };
}

/** 物差しの建物（足元の緯度経度と高さ）。 */
interface Landmark {
  lat: number;
  lon: number;
  heightM: number;
  /** 建物の幅の半分ほど(m)。建物の全体が画面に入るよう、足元の点のまわりのこの四方を収める。既定 0（点だけ）。 */
  halfWidthM?: number;
}

/** 東京駅 丸の内駅舎の中央（屋根の高さ 約 30m の点まで）。 */
const MARUNOUCHI_STATION: Landmark = { lat: 35.68124, lon: 139.76695, heightM: 30 };
/** 東京都庁第一本庁舎（243m）。 */
const TOCHO: Landmark = { ...PLACES.tochoFirstBuilding, heightM: 243, halfWidthM: 35 };

/**
 * 山の裾（12 点）と頂上、物差しの建物の上端と足元を、注視点からのずれにした fit。地表の高さは山の地点と同じとみなす。
 */
function pileFit(
  site: { lat: number; lon: number },
  target: { lat: number; lon: number; alt: number },
  pile: { heightM: number; diameterM: number },
  landmark: Landmark,
): StoryCameraFit {
  const c = offsetM(target, site);
  const r = pile.diameterM / 2;
  const points = Array.from({ length: 12 }, (_, k) => ({
    eastM: c.eastM + Math.cos((k / 12) * 2 * Math.PI) * r,
    northM: c.northM + Math.sin((k / 12) * 2 * Math.PI) * r,
    upM: -target.alt,
  }));
  points.push({ eastM: c.eastM, northM: c.northM, upM: pile.heightM - target.alt });
  // 物差しの建物は、足元の点のまわり（halfWidthM 四方）の上端と足元
  const l = offsetM(target, landmark);
  const w = landmark.halfWidthM ?? 0;
  for (const [de, dn] of w > 0 ? [[-w, -w], [-w, w], [w, -w], [w, w]] : [[0, 0]]) {
    const q = { eastM: l.eastM + de!, northM: l.northM + dn! };
    points.push({ ...q, upM: landmark.heightM - target.alt }, { ...q, upM: -target.alt });
  }
  return { eastWestM: 0, northSouthM: 0, points };
}

/**
 * 高さ・水平距離で決めた山の場面のカメラ。距離は、山と物差しの建物が本文カードに覆われていない範囲に収まる距離（`fit`）を
 * 下限にする（タブレットの縦向きなど、カードの列の右側が狭い画面でも山がはみ出さない）。
 */
function pileView(site: { lat: number; lon: number }, v: PileView, pile: { heightM: number; diameterM: number }, landmark: Landmark): StoryCameraKeyframe {
  const k = cameraFrom(offsetLatLon(site, v.azimuthDeg - 90, v.shiftM), v);
  return { ...k, fit: pileFit(site, { ...k.target, alt: k.target.alt ?? 0 }, pile, landmark) };
}

/** 横長の画面と縦長の画面のカメラ。 */
function pileCamera(site: { lat: number; lon: number }, landscape: PileView, portrait: PileView, landmark: Landmark): StoryCameraKeyframe {
  return { ...pileView(site, landscape, pile5, landmark), portrait: pileView(site, portrait, pile5, landmark) };
}

/** 場面6: 方位と俯角を決め、距離は山と都庁が収まる距離（fit）。 */
function scene6View(angles: { azimuthDeg: number; elevationDeg: number }): StoryCameraView {
  const target = { ...PLACES.shinjukuPark, alt: SCENE6_TARGET_ALT_M };
  return { target, distance: 1, ...angles, fit: pileFit(PLACES.shinjukuPark, target, pile6, TOCHO) };
}
const SCENE6_CAMERA: StoryCameraKeyframe = { ...scene6View(SCENE6_ANGLES), portrait: scene6View(SCENE6_PORTRAIT_ANGLES) };

/**
 * 23区の俯瞰の距離の下限（高さ 28km・仰角 60° のときの距離）と仰角(度)。実際の距離は `WARDS_FIT` から求め、
 * 画面が横長（PC 幅）でも縦長（スマートフォン）でも、23区の駅の範囲が本文カードに覆われていない範囲に収まるようにする。
 */
const WARDS_HEIGHT_M = 28_000;
const WARDS_ELEVATION_DEG = 60;
/** 収めたい範囲（注視点を中心とする東西・南北の幅(m)）。23区内の駅の範囲（約 30km 四方）に、柱が立つ分の余白を足した値。 */
const WARDS_FIT = { eastWestM: 31_500, northSouthM: 33_000 } as const;

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
    camera: { ...cameraFrom(P.akihabaraFirstBike, SCENE1_VIEW), portrait: cameraFrom(P.akihabaraFirstBike, SCENE1_PORTRAIT_VIEW) },
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
    camera: AKIHABARA_GROW,
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
      fit: WARDS_FIT,
    },
    place: null,
  },
  {
    id: 'parking-vacancy',
    text: {
      heading: '駐輪場には空きがあった',
      paragraphs: [
        `秋葉原駅周辺の駐輪場の収容能力は、自転車${nu(F.akihabaraCapacity)}。調査のときに止まっていたのは${nu(F.akihabaraOccupancy)}で、${nu(F.akihabaraVacancy)}が空いていた。`,
        `放置自転車があった${nu(F.stationsWithParked)}のうち${nu(F.stationsVacancyExceeds)}では、駐輪場の空きが放置自転車の台数以上あった。`,
        `都内の駅周辺の駐輪場は${nu(F.parkingLots)}、収容能力は${nu(F.parkingCapacity)}。調査のときに止まっていたのは${nu(F.parkingOccupancy)}だった。`,
      ],
      stat: stat(F.akihabaraVacancy, '秋葉原駅周辺の駐輪場の空き'),
    },
    camera: {
      target: { ...P.wards, alt: 0 },
      distance: distanceForHeight(WARDS_HEIGHT_M, WARDS_ELEVATION_DEG),
      azimuthDeg: 12,
      elevationDeg: WARDS_ELEVATION_DEG,
      fit: WARDS_FIT,
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
    camera: pileCamera(P.tokyoPlaza, SCENE5_VIEW, SCENE5_PORTRAIT_VIEW, MARUNOUCHI_STATION),
    place: { ...P.tokyoPlaza, radiusM: 1800 },
  },
  {
    id: 'removed-15years',
    text: {
      heading: `${FISCAL_YEAR - FIRST_FISCAL_YEAR + 1}年で${nu(F.removed15Years)}`,
      paragraphs: [
        `${FIRST_FISCAL_YEAR}年度から${FISCAL_YEAR}年度までの${FISCAL_YEAR - FIRST_FISCAL_YEAR + 1}年間に、都内で撤去された自転車は${nu(F.removed15Years)}。${FISCAL_YEAR}年度の撤去台数の約${nu(F.removed15YearsInYears)}にあたる。`,
        `新宿の都庁前、新宿中央公園に1つの山として積むと、高さはおよそ${nu(F.cumulativePileHeight)}、裾の直径は約${nu(F.cumulativePileDiameter)}になる。隣に立つ都庁第一本庁舎の高さは${nu(F.tochoHeight)}。`,
        `体積は約${nu(F.cumulativePileVolume)}。東京ドーム約${nu(F.cumulativePileDomes)}になる。`,
      ],
      stat: stat(F.removed15Years, `${FIRST_FISCAL_YEAR}〜${FISCAL_YEAR}年度に撤去された自転車の累計`),
    },
    camera: SCENE6_CAMERA,
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
    camera: pileCamera(P.tokyoPlaza, SCENE7_VIEW, SCENE7_PORTRAIT_VIEW, MARUNOUCHI_STATION),
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
    // 462台を、場面2 と同じ上空から見渡す（地上の目線では手前の 20台ほどしか見えなかった）
    camera: AKIHABARA_ALL,
    freeOrbit: true,
    place: { ...P.akihabaraSidewalk, radiusM: 1500 },
  },
];
