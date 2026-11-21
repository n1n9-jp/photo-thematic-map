/**
 * 秋葉原駅の周りの放置自転車 462台の配置（描画に依存しない。Web Worker と Node のテストの両方から使う）。
 *
 * - 街の高さ格子 `akihabara` の分類で路上を決める: 地面（0）と高架の下（2）に置き、建物（1）と水面（255）には置かない。
 *   高さは建物・高架を除いた地面の高さ（`ground`、国土地理院 5m メッシュ）。
 * - 分類からは分からない線路と首都高（分類では地面か橋梁だが、航空写真に線路や高速道路の路面が写る場所）は
 *   `BLOCKED_CORRIDORS` で除く。街並みには橋梁の 3D モデルを描かないので、その下に置くと路面の写真の上に見えるため。
 *   川に架かる橋（最寄りの橋梁でないセルが水面の橋梁のセル）にも置かない。
 * - 電気街口の駅前広場（場面1の注視点）に最も近い路上から、路上の経路距離で外側へ広げる。
 *   列は壁際の1〜2列に抑え、塊の間を空けて、通り沿いに長く伸ばす。
 * - 配置の範囲は駅（駅別の表の位置）から 500m 以内。
 */
import { latLonToLocal } from '../../../geo/enu';
import { GRID_CLASS, type CityGrid } from '../../../data/grids';
import { layoutStation, prepareStreetMap, type StationLayout, type StationLayoutOptions } from '../../../sim/stationLayout';

/** 秋葉原駅の周りの放置自転車の台数（facts の akihabaraParked と同じ）。 */
export const AKIHABARA_COUNT = 462;
/** 秋葉原駅（駅別の表の位置）。 */
export const AKIHABARA_STATION = { lat: 35.698439, lon: 139.774018 } as const;
/** 電気街口の駅前広場（場面1・8 の注視点）。ここに最も近い路上から置き始める。 */
export const AKIHABARA_START = { lat: 35.698815, lon: 139.772664 } as const;
/** 駅からの最大距離(m)。 */
export const AKIHABARA_RADIUS_M = 500;
export const AKIHABARA_SEED = 7;

/**
 * ほかの出口（少し遅れて置き始める）。駅の東側（中央改札口の駅前広場・昭和通り口）と南西（万世橋の方）の通りにもあふれるように。
 * delay は電気街口からの経路距離に足す遅れ(m)。
 */
export const AKIHABARA_EXTRA_STARTS: readonly { name: string; lat: number; lon: number; delay: number }[] = [
  { name: '中央改札口の駅前広場', lat: 35.698977, lon: 139.774013, delay: 10 },
  { name: '昭和通り口', lat: 35.698076, lon: 139.775007, delay: 20 },
  { name: '駅の南西', lat: 35.698166, lon: 139.772356, delay: 20 },
];

/**
 * 配置のオプション。合成した街区での既定値（壁際に2列、塊は連続）では 462台が駅から 38m 以内に収まり広がりが控えめだったので、
 * 列は壁際の1列を主にし（2列目は経路距離で 80m 遅らせる）、塊の間を空けて（ノイズが 0.68 未満の場所に置かない）、
 * 通り沿いに長く伸ばす。
 */
export const AKIHABARA_LAYOUT_OPTIONS: StationLayoutOptions = {
  radius: AKIHABARA_RADIUS_M,
  maxRows: 2,
  rowPenalty: 80,
  clumpScale: 12,
  clumpPenalty: 6,
  clumpGap: 0.68,
  centerClearance: 2.5,
  startSlack: 4,
};

/** 路上の判定のオプション。広場の売店・柱などの小さな塊（60m² 未満）は列を作る壁にしない。 */
export const AKIHABARA_STREET_OPTIONS = { minWallArea: 60 } as const;

/**
 * 自転車を置かない帯（緯度経度の折れ線と幅 m）。分類では地面か橋梁だが、航空写真に線路や高速道路の路面が写る場所。
 * 街の高さ格子の範囲（700m 四方）を真上から撮った航空写真（`demos/akihabara.html?view=plan`）で、線路の両端に
 * 1〜2m の余裕を足して測った。
 */
export const BLOCKED_CORRIDORS: readonly { name: string; widthM: number; points: readonly { lat: number; lon: number }[] }[] = [
  {
    name: '山手線・京浜東北線・東北新幹線（南北）',
    widthM: 60,
    points: [
      { lat: 35.701591, lon: 139.773251 },
      { lat: 35.699788, lon: 139.773251 },
      { lat: 35.698887, lon: 139.773217 },
      { lat: 35.697986, lon: 139.773129 },
      { lat: 35.697355, lon: 139.773085 },
      { lat: 35.696634, lon: 139.772997 },
      { lat: 35.696183, lon: 139.772831 },
      { lat: 35.695733, lon: 139.772699 },
      { lat: 35.695282, lon: 139.772555 },
    ],
  },
  {
    name: '総武線（駅の西）',
    widthM: 20,
    points: [
      { lat: 35.698558, lon: 139.770147 },
      { lat: 35.698558, lon: 139.772908 },
    ],
  },
  {
    name: '総武線（駅の東）',
    widthM: 17,
    points: [
      { lat: 35.698211, lon: 139.774786 },
      { lat: 35.697959, lon: 139.777879 },
    ],
  },
  {
    name: '中央線（万世橋の南）',
    widthM: 18,
    points: [
      { lat: 35.697039, lon: 139.770257 },
      { lat: 35.696949, lon: 139.770533 },
      { lat: 35.696769, lon: 139.77081 },
      { lat: 35.696499, lon: 139.771008 },
      { lat: 35.696183, lon: 139.771196 },
      { lat: 35.695778, lon: 139.771362 },
      { lat: 35.695282, lon: 139.771528 },
    ],
  },
  {
    name: '首都高速1号上野線（昭和通りの上）',
    widthM: 40,
    points: [
      { lat: 35.701591, lon: 139.775555 },
      { lat: 35.698887, lon: 139.775555 },
      { lat: 35.697986, lon: 139.775500 },
      { lat: 35.695282, lon: 139.775401 },
    ],
  },
];

export interface AkihabaraLayoutResult {
  layout: StationLayout;
  /** 地面（分類 0）に置いた台数と、高架の下（分類 2）に置いた台数。 */
  onGround: number;
  underBridge: number;
  /** 駅から最も遠い自転車までの距離(m)（自転車の端まで）。 */
  maxDistanceM: number;
  /** 置き始めた点から最も遠い自転車までの距離(m)。 */
  maxFromStartM: number;
  prepareMs: number;
  layoutMs: number;
  station: { x: number; z: number };
  start: { x: number; z: number };
}

/** 点 (px, pz) から線分 (ax, az)-(bx, bz) までの距離。 */
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** 置かない帯（`BLOCKED_CORRIDORS`）にかかるセルを 1 にした配列。 */
export function corridorMask(grid: CityGrid['ground']): Uint8Array {
  const { width: W, height: H, cellSize: cs, originX, originZ } = grid;
  const mask = new Uint8Array(W * H);
  for (const corridor of BLOCKED_CORRIDORS) {
    const pts = corridor.points.map((p) => latLonToLocal({ lat: p.lat, lon: p.lon }));
    const half = corridor.widthM / 2;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - half - originX) / cs));
      const c1 = Math.min(W - 1, Math.floor((Math.max(a.x, b.x) + half - originX) / cs));
      const r0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - half - originZ) / cs));
      const r1 = Math.min(H - 1, Math.floor((Math.max(a.z, b.z) + half - originZ) / cs));
      for (let r = r0; r <= r1; r++) {
        const z = originZ + (r + 0.5) * cs;
        for (let c = c0; c <= c1; c++) {
          const x = originX + (c + 0.5) * cs;
          if (segmentDistance(x, z, a.x, a.z, b.x, b.z) <= half) mask[r * W + c] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * 川に架かる橋のセルを 1 にした配列。橋梁（分類2）のセルに、最も近い橋梁でないセルの分類を広げ（4近傍の幅優先）、
 * それが水面（255）なら川の上の橋とみなす。
 */
export function bridgeOverWaterMask(classes: Uint8Array, W: number, H: number): Uint8Array {
  const N = W * H;
  const water = new Int8Array(N).fill(-1); // -1 未定、0 陸、1 水
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < N; i++) {
    if (classes[i] === GRID_CLASS.bridge) continue;
    water[i] = classes[i] === GRID_CLASS.nodata ? 1 : 0;
    queue[tail++] = i;
  }
  while (head < tail) {
    const i = queue[head++]!;
    const r = (i / W) | 0;
    const c = i - r * W;
    const visit = (j: number): void => {
      if (water[j] !== -1) return;
      water[j] = water[i]!;
      queue[tail++] = j;
    };
    if (c > 0) visit(i - 1);
    if (c < W - 1) visit(i + 1);
    if (r > 0) visit(i - W);
    if (r < H - 1) visit(i + W);
  }
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (classes[i] === GRID_CLASS.bridge && water[i] === 1) mask[i] = 1;
  return mask;
}

/** 分類のほかに置かないセル（置かない帯と川の上の橋）。 */
export function blockedMask(grid: CityGrid): Uint8Array {
  const g = grid.ground;
  const mask = corridorMask(g);
  const overWater = bridgeOverWaterMask(grid.classes, g.width, g.height);
  for (let i = 0; i < mask.length; i++) if (overWater[i] === 1) mask[i] = 1;
  return mask;
}

/** 秋葉原の格子から 462台を配置する。 */
export function computeAkihabaraLayout(grid: CityGrid, count = AKIHABARA_COUNT): AkihabaraLayoutResult {
  const s = latLonToLocal(AKIHABARA_STATION);
  const f = latLonToLocal(AKIHABARA_START);
  const station = { x: s.x, z: s.z };
  const start = { x: f.x, z: f.z };
  const t0 = performance.now();
  const map = prepareStreetMap(grid.ground, { ...AKIHABARA_STREET_OPTIONS, classes: grid.classes, blocked: blockedMask(grid) });
  const t1 = performance.now();
  const extraStarts = AKIHABARA_EXTRA_STARTS.map((e) => {
    const p = latLonToLocal(e);
    return { x: p.x, z: p.z, delay: e.delay };
  });
  const layout = layoutStation(map, station, count, AKIHABARA_SEED, { ...AKIHABARA_LAYOUT_OPTIONS, start, extraStarts });
  const t2 = performance.now();
  const g = grid.ground;
  let onGround = 0;
  let underBridge = 0;
  let maxDistanceM = 0;
  let maxFromStartM = 0;
  for (let i = 0; i < layout.count; i++) {
    const x = layout.positions[i * 3]!;
    const z = layout.positions[i * 3 + 2]!;
    const c = Math.floor((x - g.originX) / g.cellSize);
    const r = Math.floor((z - g.originZ) / g.cellSize);
    const k = grid.classes[r * g.width + c];
    if (k === 2) underBridge++;
    else onGround++;
    maxDistanceM = Math.max(maxDistanceM, Math.hypot(x - station.x, z - station.z) + layout.bikeLength / 2);
    maxFromStartM = Math.max(maxFromStartM, Math.hypot(x - start.x, z - start.z));
  }
  return { layout, onGround, underBridge, maxDistanceM, maxFromStartM, prepareMs: t1 - t0, layoutMs: t2 - t1, station, start };
}
