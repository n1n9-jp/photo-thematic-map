/**
 * 駅の周りの路上に、放置自転車を1台ずつ配置する（描画に依存しない純粋ロジック）。
 *
 * 統計で分かるのは駅ごとの台数だけなので、配置は図示のためのもの。ただし台数は必ず正確に置く。
 *
 * ## 手順
 * 1. 路上の判定（`prepareStreetMap`。格子ごとに1回だけ計算し、複数の駅で使い回せる）
 *    - 隣り合うセルの高さの差が `buildingStep` 未満なら同じ面としてつなぎ、連結成分に分ける。
 *    - 成分の境界で「隣の成分が高い（壁が立ち上がる）」辺と「隣が低い（屋上の縁から落ちる）」辺を数え、
 *      立ち上がりが落ち込み以上の成分を地表（路上）とする。屋上は周囲より高いので落ち込みが多い。
 *      小さすぎる成分（`minStreetArea` 未満）と欠損（NaN）は路上にしない。
 *    - 路上以外のセル（建物・欠損）を壁とみなし、各路上セルから最寄りの壁面までの距離と、
 *      壁から離れる向き（法線）を求める（ベクトル伝播による距離変換）。
 *    - 壁からの距離の近傍最大値を、その場所の「通りの半幅」とする。
 * 2. 配置（`layoutStation`）
 *    - 駅に最も近い路上セル（とそこから startSlack 以内の路上セル）を始点に、
 *      路上だけを通る最短経路距離（Dijkstra）で外側へ広げる。
 *    - 壁から決まった距離（列 k の中心 = wallGap + 全長/2 + k * rowSpacing）の等値線上に候補点を作る。
 *      自転車は壁に直交する向きで、列に沿って並ぶ。通りの中央から `centerClearance` 以内に入る列は作らない。
 *    - 候補の優先度 = 経路距離 + 列番号 * rowPenalty + 塊のノイズ * clumpPenalty + 小さな乱れ。
 *      壁際の列から、駅に近い方から、塊になって埋まる。
 *    - 同じ列にすでに隣がいれば、隣から中心間隔（0.5〜0.6m）ぶん離れた位置へ寄せ、隣と逆向きに前後へずらす
 *      （1台おきに前後へずらして、ハンドルとかごが当たらないようにする）。向きと傾きは少しばらつかせる。
 *    - 優先度の小さい候補から、他の自転車と重ならず、足元がすべて平らな路上で、駅から radius 以内なら置く。
 *      Dijkstra の前線より優先度の小さい候補だけを確定するので、結果は優先度の順に並ぶ。
 *    - 台数に達したら止める。置ける場所が尽きたら例外を投げる。
 *
 * 返り値の配列は置いた順に並んでいる。先頭の k 台が「k 台のときの配置」になる。
 */
import type { HeightGrid } from './heightGrid';
import { mulberry32 } from './syntheticCity';

/** 路上の判定のオプション。 */
export interface StreetMapOptions {
  /** これ以上の高さの段差を壁（建物の縁）とみなす(m)。既定 2.0。 */
  buildingStep?: number;
  /** これより小さい地表の成分は路上にしない(m²)。既定 8。 */
  minStreetArea?: number;
  /** 通りの半幅を求める近傍の半径(m)。既定 12。 */
  halfWidthWindow?: number;
}

/** 格子から求めた路上の情報。複数の駅の配置で共有できる。 */
export interface StreetMap {
  grid: HeightGrid;
  /** 1 = 路上。長さ width*height。 */
  street: Uint8Array;
  /** 最寄りの壁面（路上でないセルの縁）までの距離(m)。路上でないセルは 0。壁が見つからなければ大きな値。 */
  wallDist: Float32Array;
  /** 壁から離れる向きの単位ベクトル（X, Z）。 */
  normalX: Float32Array;
  normalZ: Float32Array;
  /** 通りの半幅の目安(m)（wallDist の近傍最大値）。 */
  halfWidth: Float32Array;
}

/** 配置のオプション。 */
export interface StationLayoutOptions {
  /** 駅からの最大距離(m)。自転車の全体がこの円に収まる。既定 500。 */
  radius?: number;
  /** 1台の占有の長さ(m)。既定 1.8。 */
  bikeLength?: number;
  /** 列の中の中心間隔の範囲(m)。既定 [0.5, 0.6]。 */
  pitch?: readonly [number, number];
  /** 壁面と自転車の端のすき間(m)。既定 0.25。 */
  wallGap?: number;
  /** 列どうしの中心の間隔(m)。既定 2.2。 */
  rowSpacing?: number;
  /** 壁からの列の数の上限。既定 4。 */
  maxRows?: number;
  /** 通りの中央線から自転車の端までに空ける距離(m)。既定 2.0。 */
  centerClearance?: number;
  /** 列が1つ外側になるごとの優先度の加算(m)。既定 20。 */
  rowPenalty?: number;
  /** 塊のノイズの優先度への重み(m)。既定 10。 */
  clumpPenalty?: number;
  /** 塊のノイズの大きさ(m)。既定 14。 */
  clumpScale?: number;
  /** 優先度に加える乱れの幅(m)。既定 2。 */
  orderJitter?: number;
  /**
   * 駅に最も近い路上セルからこの距離(m)以内にある路上セルも始点にする。既定 15。
   * 駅の位置が駅舎の上にあるとき、駅舎の片側だけでなく周りの通りから置き始めるため。
   */
  startSlack?: number;
  /** 足元の高さの許容差(m)。これを超える段差の上には置かない。既定 0.4。 */
  flatness?: number;
  /** 路上の判定のオプション（HeightGrid を渡したときに使う）。 */
  street?: StreetMapOptions;
}

/** 配置の結果。すべての配列は置いた順（駅に近い順）に並ぶ。 */
export interface StationLayout {
  count: number;
  /** 位置 (x, y, z)。y はそのセルの地表の高さ。長さ 3N。 */
  positions: Float32Array;
  /** Y 軸まわりの角度（ラジアン。0 で前輪が +X 向き、正で +X から −Z（北）へ回る）。長さ N。 */
  yaws: Float32Array;
  /** 進行方向の軸まわりの傾き（ラジアン、スタンドで立つ小さな傾き）。長さ N。 */
  rolls: Float32Array;
  /** 衝突判定に使った占有の幅(m)（= 列の中の中心間隔 − 0.08。向きのばらつきのぶんの余裕）。長さ N。 */
  widths: Float32Array;
  /** 駅からの路上の経路距離(m)。長さ N。 */
  pathDistances: Float32Array;
  /** 壁から数えた列の番号（0 が壁際）。長さ N。 */
  rows: Uint8Array;
  /** 配置を始めた路上の点（駅に最も近い路上セルの中心）。 */
  start: { x: number; z: number };
  /** 占有の長さ(m)。 */
  bikeLength: number;
}

const BIG = 1e9;
/** 中心間隔から衝突判定の幅を求めるときに引く余裕(m)。向きのばらつきのぶん。 */
const WIDTH_MARGIN = 0.08;

/** 格子から路上の情報を作る。 */
export function prepareStreetMap(grid: HeightGrid, options: StreetMapOptions = {}): StreetMap {
  const step = options.buildingStep ?? 2.0;
  const minArea = options.minStreetArea ?? 8;
  const window = options.halfWidthWindow ?? 12;
  const { width: W, height: H, cellSize: cs, data } = grid;
  const N = W * H;

  // 1. 段差でつながる連結成分
  const label = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const area: number[] = [];
  let comps = 0;
  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || Number.isNaN(data[s]!)) continue;
    const id = comps++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = id;
    let n = 0;
    while (head < tail) {
      const i = queue[head++]!;
      n++;
      const r = (i / W) | 0;
      const c = i - r * W;
      const h = data[i]!;
      // 4近傍
      for (let k = 0; k < 4; k++) {
        let j: number;
        if (k === 0) {
          if (c === 0) continue;
          j = i - 1;
        } else if (k === 1) {
          if (c === W - 1) continue;
          j = i + 1;
        } else if (k === 2) {
          if (r === 0) continue;
          j = i - W;
        } else {
          if (r === H - 1) continue;
          j = i + W;
        }
        if (label[j] !== -1) continue;
        const hj = data[j]!;
        if (Number.isNaN(hj) || Math.abs(hj - h) >= step) continue;
        label[j] = id;
        queue[tail++] = j;
      }
    }
    area.push(n);
  }

  // 2. 成分ごとの立ち上がり・落ち込みの辺の数
  const rise = new Float64Array(comps);
  const drop = new Float64Array(comps);
  const countEdge = (a: number, b: number): void => {
    const ha = data[a]!;
    const hb = data[b]!;
    if (Number.isNaN(ha) || Number.isNaN(hb)) return;
    const la = label[a]!;
    const lb = label[b]!;
    if (la === lb) return;
    if (hb - ha >= step) {
      rise[la]!++;
      drop[lb]!++;
    } else if (ha - hb >= step) {
      drop[la]!++;
      rise[lb]!++;
    }
  };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (c + 1 < W) countEdge(i, i + 1);
      if (r + 1 < H) countEdge(i, i + W);
    }
  }
  const minCells = minArea / (cs * cs);
  const isStreetComp = new Uint8Array(comps);
  for (let k = 0; k < comps; k++) isStreetComp[k] = area[k]! >= minCells && rise[k]! >= drop[k]! ? 1 : 0;
  const street = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const l = label[i]!;
    street[i] = l >= 0 && isStreetComp[l] === 1 ? 1 : 0;
  }

  // 3. 最寄りの壁（路上でないセル）へのベクトル（8SSEDT のベクトル伝播）
  const vx = new Int32Array(N);
  const vz = new Int32Array(N);
  const INF = 1 << 20;
  for (let i = 0; i < N; i++) {
    if (street[i] === 1) {
      vx[i] = INF;
      vz[i] = INF;
    }
  }
  const d2 = (x: number, z: number): number => x * x + z * z;
  const relax = (i: number, j: number, ox: number, oz: number): void => {
    // j の最寄りの壁を i から見る: i→壁 = (j - i) + (j→壁)
    if (vx[j] === INF) return;
    const nx = vx[j]! + ox;
    const nz = vz[j]! + oz;
    if (vx[i] === INF || d2(nx, nz) < d2(vx[i]!, vz[i]!)) {
      vx[i] = nx;
      vz[i] = nz;
    }
  };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (street[i] === 0) continue;
      if (c > 0) relax(i, i - 1, -1, 0);
      if (r > 0) {
        relax(i, i - W, 0, -1);
        if (c > 0) relax(i, i - W - 1, -1, -1);
        if (c < W - 1) relax(i, i - W + 1, 1, -1);
      }
    }
    for (let c = W - 1; c >= 0; c--) {
      const i = r * W + c;
      if (street[i] === 1 && c < W - 1) relax(i, i + 1, 1, 0);
    }
  }
  for (let r = H - 1; r >= 0; r--) {
    for (let c = W - 1; c >= 0; c--) {
      const i = r * W + c;
      if (street[i] === 0) continue;
      if (c < W - 1) relax(i, i + 1, 1, 0);
      if (r < H - 1) {
        relax(i, i + W, 0, 1);
        if (c < W - 1) relax(i, i + W + 1, 1, 1);
        if (c > 0) relax(i, i + W - 1, -1, 1);
      }
    }
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (street[i] === 1 && c > 0) relax(i, i - 1, -1, 0);
    }
  }
  const wallDist = new Float32Array(N);
  const normalX = new Float32Array(N);
  const normalZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (street[i] === 0) continue;
    if (vx[i] === INF) {
      wallDist[i] = BIG;
      continue;
    }
    const dx = vx[i]!;
    const dz = vz[i]!;
    // 壁のセル（一辺 cs の正方形）の縁までの距離
    const ax = Math.max(Math.abs(dx) - 0.5, 0);
    const az = Math.max(Math.abs(dz) - 0.5, 0);
    wallDist[i] = Math.hypot(ax, az) * cs;
    const len = Math.hypot(dx, dz);
    normalX[i] = -dx / len;
    normalZ[i] = -dz / len;
  }

  // 4. 通りの半幅（wallDist の近傍最大値。正方形の窓を行・列に分けて計算）
  const R = Math.max(1, Math.round(window / cs));
  const src = new Float32Array(N);
  for (let i = 0; i < N; i++) src[i] = Math.min(wallDist[i]!, 1e4);
  const tmp = new Float32Array(N);
  slidingMax(src, tmp, W, H, 1, W, R);
  const halfWidth = new Float32Array(N);
  slidingMax(tmp, halfWidth, H, W, W, 1, R);

  return { grid, street, wallDist, normalX, normalZ, halfWidth };
}

/**
 * 1次元の窓最大値（van Herk / Gil-Werman 法、1要素あたり定数時間）を、多数の線に対して計算する。
 * 線 l の k 番目の要素は `l * lineStride + k * step`。窓は [k-R, k+R]（端は切り詰め）。
 */
function slidingMax(
  src: Float32Array,
  dst: Float32Array,
  lines: number,
  len: number,
  lineStride: number,
  step: number,
  R: number,
): void {
  const w = 2 * R + 1;
  const pre = new Float32Array(len);
  const suf = new Float32Array(len);
  for (let l = 0; l < lines; l++) {
    const o = l * lineStride;
    for (let k = 0; k < len; k++) {
      const v = src[o + k * step]!;
      pre[k] = k % w === 0 ? v : Math.max(pre[k - 1]!, v);
    }
    for (let k = len - 1; k >= 0; k--) {
      const v = src[o + k * step]!;
      suf[k] = k === len - 1 || (k + 1) % w === 0 ? v : Math.max(suf[k + 1]!, v);
    }
    for (let k = 0; k < len; k++) {
      const a = Math.max(0, k - R);
      const b = Math.min(len - 1, k + R);
      // 長さ w 以下の [a, b] はブロック境界をたかだか1つまたぐ。
      // またぐなら suf[a]（a からブロック末尾まで）と pre[b]（ブロック先頭から b まで）の最大。
      // 同じブロック内なら、a がブロック先頭のとき pre[b]、そうでなければ b が線の末尾なので suf[a]。
      const ba = (a / w) | 0;
      const bb = (b / w) | 0;
      dst[o + k * step] = ba !== bb ? Math.max(suf[a]!, pre[b]!) : a % w === 0 ? pre[b]! : suf[a]!;
    }
  }
}

/** 優先度つきキュー（キーが小さい順）。 */
class MinHeap {
  private keys = new Float64Array(64);
  private vals = new Int32Array(64);
  size = 0;

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.keys[i] = this.keys[p]!;
      this.vals[i] = this.vals[p]!;
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  peekKey(): number {
    return this.size > 0 ? this.keys[0]! : Infinity;
  }

  pop(): number {
    const top = this.vals[0]!;
    const n = --this.size;
    if (n > 0) {
      const key = this.keys[n]!;
      const val = this.vals[n]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && this.keys[r]! < this.keys[l]! ? r : l;
        if (this.keys[m]! >= key) break;
        this.keys[i] = this.keys[m]!;
        this.vals[i] = this.vals[m]!;
        i = m;
      }
      this.keys[i] = key;
      this.vals[i] = val;
    }
    return top;
  }
}

/** 整数格子点の擬似乱数（0..1）。 */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 滑らかな値ノイズ（0..1）。 */
function valueNoise(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** 2つの向き付き長方形（中心・軸の向き・半分の長さ・半分の幅）が重なるか（分離軸判定）。 */
export function orientedRectsOverlap(
  ax: number,
  az: number,
  aYaw: number,
  aHalfLen: number,
  aHalfWid: number,
  bx: number,
  bz: number,
  bYaw: number,
  bHalfLen: number,
  bHalfWid: number,
): boolean {
  // 軸: 長さ方向 (cos, -sin)、幅方向 (sin, cos)
  const aux = Math.cos(aYaw);
  const auz = -Math.sin(aYaw);
  const bux = Math.cos(bYaw);
  const buz = -Math.sin(bYaw);
  const axes = [aux, auz, -auz, aux, bux, buz, -buz, bux];
  const dx = bx - ax;
  const dz = bz - az;
  for (let k = 0; k < 4; k++) {
    const nx = axes[k * 2]!;
    const nz = axes[k * 2 + 1]!;
    const ra = aHalfLen * Math.abs(aux * nx + auz * nz) + aHalfWid * Math.abs(-auz * nx + aux * nz);
    const rb = bHalfLen * Math.abs(bux * nx + buz * nz) + bHalfWid * Math.abs(-buz * nx + bux * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb) return false;
  }
  return true;
}

/** 駅に最も近い路上セル。radius 以内に無ければ -1。 */
function nearestStreetCell(map: StreetMap, x: number, z: number, radius: number): number {
  const g = map.grid;
  const cs = g.cellSize;
  const c0 = Math.floor((x - g.originX) / cs);
  const r0 = Math.floor((z - g.originZ) / cs);
  const maxRing = Math.ceil(radius / cs) + 1;
  let best = -1;
  let bestD = Infinity;
  for (let ring = 0; ring <= maxRing; ring++) {
    // ring の外側にあるセルは ring*cs - cs 以上離れているので、見つかったら1周余分に調べて止める
    if (best >= 0 && (ring - 1) * cs > bestD) break;
    for (let r = r0 - ring; r <= r0 + ring; r++) {
      if (r < 0 || r >= g.height) continue;
      const onEdge = r === r0 - ring || r === r0 + ring;
      for (let c = c0 - ring; c <= c0 + ring; c += onEdge ? 1 : 2 * ring || 1) {
        if (c < 0 || c >= g.width) continue;
        const i = r * g.width + c;
        if (map.street[i] !== 1) continue;
        const cx = g.originX + (c + 0.5) * cs;
        const cz = g.originZ + (r + 0.5) * cs;
        const d = Math.hypot(cx - x, cz - z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return bestD <= radius ? best : -1;
}

/**
 * 駅の周りの路上に count 台を配置する。
 * @param input 高さ格子（欠損は NaN）、または `prepareStreetMap` の結果（複数の駅で使い回すとき）
 * @param station 駅の位置（ローカル座標 x, z）
 * @param count 台数（0 以上の整数）
 * @param seed 乱数の種
 * @throws 置ける場所が足りないとき
 */
export function layoutStation(
  input: HeightGrid | StreetMap,
  station: { x: number; z: number },
  count: number,
  seed: number,
  options: StationLayoutOptions = {},
): StationLayout {
  if (!(Number.isInteger(count) && count >= 0)) throw new Error(`台数が不正です: ${count}`);
  const map = 'street' in input ? input : prepareStreetMap(input, options.street);
  const g = map.grid;
  const { width: W, height: H, cellSize: cs, data } = g;
  const radius = options.radius ?? 500;
  const L = options.bikeLength ?? 1.8;
  const halfL = L / 2;
  const [pitchMin, pitchMax] = options.pitch ?? [0.5, 0.6];
  const wallGap = options.wallGap ?? 0.25;
  const rowSpacing = options.rowSpacing ?? 2.2;
  const maxRows = options.maxRows ?? 4;
  const centerClear = options.centerClearance ?? 2.0;
  const rowPenalty = options.rowPenalty ?? 20;
  const clumpPenalty = options.clumpPenalty ?? 10;
  const clumpScale = options.clumpScale ?? 14;
  const jitter = options.orderJitter ?? 2;
  const flatness = options.flatness ?? 0.4;
  const startSlack = options.startSlack ?? 15;

  const out: StationLayout = {
    count,
    positions: new Float32Array(count * 3),
    yaws: new Float32Array(count),
    rolls: new Float32Array(count),
    widths: new Float32Array(count),
    pathDistances: new Float32Array(count),
    rows: new Uint8Array(count),
    start: { x: station.x, z: station.z },
    bikeLength: L,
  };
  if (count === 0) return out;

  const startCell = nearestStreetCell(map, station.x, station.z, radius);
  if (startCell < 0) throw new Error('駅の周りに路上のセルがありません');
  const sr = (startCell / W) | 0;
  const sc = startCell - sr * W;
  out.start = { x: g.originX + (sc + 0.5) * cs, z: g.originZ + (sr + 0.5) * cs };

  const rand = mulberry32(seed);
  const noiseSeed = Math.floor(rand() * 2 ** 31);
  const rowCenter = (k: number): number => wallGap + halfL + k * rowSpacing;
  const maxBand = rowCenter(maxRows - 1) + cs;

  // 足元の判定: 長方形内の点がすべて平らな路上か
  const streetHeightAt = (x: number, z: number): number => {
    const c = Math.floor((x - g.originX) / cs);
    const r = Math.floor((z - g.originZ) / cs);
    if (c < 0 || r < 0 || c >= W || r >= H) return NaN;
    const i = r * W + c;
    return map.street[i] === 1 ? data[i]! : NaN;
  };
  const footprintOk = (x: number, z: number, yaw: number, halfW: number, y0: number): boolean => {
    const ux = Math.cos(yaw);
    const uz = -Math.sin(yaw);
    for (let a = -1; a <= 1; a += 0.5) {
      for (let b = -1; b <= 1; b += 1) {
        const px = x + ux * a * halfL * 0.98 + -uz * b * halfW;
        const pz = z + uz * a * halfL * 0.98 + ux * b * halfW;
        const h = streetHeightAt(px, pz);
        if (Number.isNaN(h) || Math.abs(h - y0) > flatness) return false;
      }
    }
    return true;
  };

  // 衝突判定用の空間ハッシュ（2m 四方）
  const BUCKET = 2;
  const buckets = new Map<number, number[]>();
  const bucketKey = (bx: number, bz: number): number => (bx + 32768) * 65536 + (bz + 32768);
  const collides = (x: number, z: number, yaw: number, halfW: number): boolean => {
    const bx = Math.floor(x / BUCKET);
    const bz = Math.floor(z / BUCKET);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = buckets.get(bucketKey(bx + ox, bz + oz));
        if (!list) continue;
        for (const j of list) {
          const jx = out.positions[j * 3]!;
          const jz = out.positions[j * 3 + 2]!;
          if (Math.abs(jx - x) > L + 0.2 || Math.abs(jz - z) > L + 0.2) continue;
          if (orientedRectsOverlap(x, z, yaw, halfL, halfW, jx, jz, out.yaws[j]!, halfL, out.widths[j]! / 2)) return true;
        }
      }
    }
    return false;
  };

  // 候補
  const candX: number[] = [];
  const candZ: number[] = [];
  const candNX: number[] = [];
  const candNZ: number[] = [];
  const candRow: number[] = [];
  const candG: number[] = [];
  const cands = new MinHeap();
  const subStep = 0.1;

  const addCandidates = (i: number, gDist: number): void => {
    const w = map.wallDist[i]!;
    if (w > maxBand) return;
    const r = (i / W) | 0;
    const c = i - r * W;
    const cx = g.originX + (c + 0.5) * cs;
    const cz = g.originZ + (r + 0.5) * cs;
    const nx = map.normalX[i]!;
    const nz = map.normalZ[i]!;
    const tx = -nz;
    const tz = nx;
    for (let k = 0; k < maxRows; k++) {
      const d = rowCenter(k);
      if (Math.abs(w - d) > cs * 0.75) continue;
      if (d + halfL + centerClear > map.halfWidth[i]!) continue;
      const px = cx + (d - w) * nx;
      const pz = cz + (d - w) * nz;
      const steps = Math.max(1, Math.round(cs / subStep));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) * (cs / steps) - cs / 2;
        const x = px + tx * t;
        const z = pz + tz * t;
        const pr =
          gDist + k * rowPenalty + clumpPenalty * valueNoise(x, z, clumpScale, noiseSeed) + jitter * hash2(Math.round(x * 20), Math.round(z * 20), noiseSeed + 7);
        const id = candX.length;
        candX.push(x);
        candZ.push(z);
        candNX.push(nx);
        candNZ.push(nz);
        candRow.push(k);
        candG.push(gDist);
        cands.push(pr, id);
      }
    }
  };

  let placed = 0;
  const staggerSign = new Int8Array(count);
  const tryPlace = (id: number): void => {
    const k = candRow[id]!;
    const nx = candNX[id]!;
    const nz = candNZ[id]!;
    const tx = -nz;
    const tz = nx;
    let x = candX[id]!;
    let z = candZ[id]!;
    const pitch = pitchMin + (pitchMax - pitchMin) * hash2(Math.round(x * 50), Math.round(z * 50), noiseSeed + 31);
    // 同じ列の隣がいれば、列に沿って隣から中心間隔ぶん離れた位置へ寄せる（間隔をそろえる）
    let neighbor = -1;
    let neighborS = 0;
    {
      const bx = Math.floor(x / BUCKET);
      const bz = Math.floor(z / BUCKET);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const list = buckets.get(bucketKey(bx + ox, bz + oz));
          if (!list) continue;
          for (const j of list) {
            if (out.rows[j] !== k) continue;
            const rx = out.positions[j * 3]! - x;
            const rz = out.positions[j * 3 + 2]! - z;
            const a = rx * nx + rz * nz;
            const sAlong = rx * tx + rz * tz;
            if (Math.abs(a) > 0.45 || Math.abs(sAlong) > pitch + 0.3) continue;
            if (neighbor < 0 || Math.abs(sAlong) < Math.abs(neighborS)) {
              neighbor = j;
              neighborS = sAlong;
            }
          }
        }
      }
    }
    let sign: number;
    if (neighbor >= 0) {
      const pairPitch = (pitch + out.widths[neighbor]! + WIDTH_MARGIN) / 2;
      const shift = neighborS - (neighborS >= 0 ? 1 : -1) * pairPitch;
      x += tx * shift;
      z += tz * shift;
      sign = -staggerSign[neighbor]!;
    } else {
      sign = (Math.floor((tx * x + tz * z) / ((pitchMin + pitchMax) / 2)) & 1) === 0 ? 1 : -1;
    }
    // 1台おきに前後へずらす（かごとハンドルが当たらないように）
    const stagger = sign * 0.09;
    x += nx * stagger;
    z += nz * stagger;
    if (Math.hypot(x - station.x, z - station.z) + halfL > radius) return;
    const y = streetHeightAt(x, z);
    if (Number.isNaN(y)) return;
    // 向き: 壁際の列は前輪を壁へ、次の列は背中合わせ（前輪を通りへ）。
    const fx = k % 2 === 0 ? -nx : nx;
    const fz = k % 2 === 0 ? -nz : nz;
    const u = hash2(Math.round(x * 50), Math.round(z * 50), noiseSeed + 13);
    const u2 = hash2(Math.round(x * 50), Math.round(z * 50), noiseSeed + 29);
    let yaw = Math.atan2(-fz, fx) + (u - 0.5) * 0.07;
    if (u2 < 0.05) yaw += (u2 / 0.05 - 0.5) * 0.4;
    // 占有の幅: 隣と中心間隔 pitch で並べても、向きの小さなばらつきで重ならない幅
    const width = pitch - WIDTH_MARGIN;
    if (collides(x, z, yaw, width / 2)) return;
    if (!footprintOk(x, z, yaw, width / 2, y)) return;
    out.positions[placed * 3] = x;
    out.positions[placed * 3 + 1] = y;
    out.positions[placed * 3 + 2] = z;
    out.yaws[placed] = yaw;
    out.rolls[placed] = (hash2(Math.round(x * 50), Math.round(z * 50), noiseSeed + 41) - 0.5) * 0.1;
    out.widths[placed] = width;
    staggerSign[placed] = sign;
    out.pathDistances[placed] = candG[id]!;
    out.rows[placed] = k;
    const key = bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET));
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(placed);
    placed++;
  };

  // 路上の経路距離で外側へ広げる（Dijkstra）。
  // 始点は駅に最も近い路上セルから startSlack 以内の路上セルすべて（駅舎の周りの各出口に相当）。
  // 始点の距離は駅からの直線距離にする。
  const dist = new Float64Array(W * H).fill(Infinity);
  const front = new MinHeap();
  const nearest = Math.hypot(out.start.x - station.x, out.start.z - station.z);
  const seedRadius = nearest + startSlack;
  {
    const c0 = Math.max(0, Math.floor((station.x - seedRadius - g.originX) / cs));
    const c1 = Math.min(W - 1, Math.floor((station.x + seedRadius - g.originX) / cs));
    const r0 = Math.max(0, Math.floor((station.z - seedRadius - g.originZ) / cs));
    const r1 = Math.min(H - 1, Math.floor((station.z + seedRadius - g.originZ) / cs));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * W + c;
        if (map.street[i] !== 1) continue;
        const d = Math.hypot(g.originX + (c + 0.5) * cs - station.x, g.originZ + (r + 0.5) * cs - station.z);
        if (d > seedRadius || d > radius) continue;
        dist[i] = d;
        front.push(d, i);
      }
    }
  }
  const diag = cs * Math.SQRT2;
  while (placed < count) {
    let gNow = Infinity;
    if (front.size > 0) {
      gNow = front.peekKey();
      const i = front.pop();
      if (gNow > dist[i]!) continue;
      addCandidates(i, gNow);
      const r = (i / W) | 0;
      const c = i - r * W;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= H) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const cc = c + dc;
          if (cc < 0 || cc >= W) continue;
          const j = rr * W + cc;
          if (map.street[j] !== 1) continue;
          const jx = g.originX + (cc + 0.5) * cs;
          const jz = g.originZ + (rr + 0.5) * cs;
          if (Math.hypot(jx - station.x, jz - station.z) > radius + cs) continue;
          const nd = gNow + (dr !== 0 && dc !== 0 ? diag : cs);
          if (nd < dist[j]!) {
            dist[j] = nd;
            front.push(nd, j);
          }
        }
      }
    } else if (cands.size === 0) {
      throw new Error(`置ける場所が足りません: ${count} 台のうち ${placed} 台しか置けませんでした`);
    }
    // 前線より優先度の小さい候補を確定する（以後の候補の優先度は gNow 以上）
    while (placed < count && cands.size > 0 && cands.peekKey() <= gNow) tryPlace(cands.pop());
  }
  return out;
}
