/**
 * 堆積計算: ある体積の物を街の点に積んだときの山の形。
 *
 * 方式（安息角つきの「回り込み円錐」）:
 * 投入点 i の頂上の高さを A_i とすると、セル x の山の表面の高さは
 *   P(x) = max_i ( A_i − tanθ · d_i(x) )
 * で決まる。d_i(x) は投入点から x までの「山の表面が地表より上にあるセルだけを通る」
 * 最短距離（建物を障害物とした回り込み距離）。表面より高い建物は通れないので遮られ、
 * 表面が屋上より高くなれば屋上も通れる（＝屋上にも積もる）。
 * この P は「P が大きい順に確定させる Dijkstra（priority-flood）」1回で厳密に求まる。
 * 近傍は 16 方向（上下左右・斜め・桂馬）を使い、格子距離の異方性を小さくしている。
 *
 * 体積は A_i を調整して合わせる。各セルを P を与えた投入点（owner）に割り当て、
 * 投入点ごとの体積が目標に近づくよう A_i を更新し（体積 ∝ 高さ³ を使った反復）、
 * 最後に全体の高さを共通倍率で補正して総体積を合わせる。
 *
 * 性質:
 * - 隣接する（ともに堆積のある）セル間の表面の差は tanθ × セル中心間距離 以下
 *   （上下左右・斜めとも Dijkstra の辺として直接つながっているので離散的に厳密）。
 * - 複数の投入点の山は max で合成されるので、接すれば一つの連続した表面になる。
 */
import type { HeightGrid } from './heightGrid';

/** 投入点。座標は three.js ローカル座標（X=東, Z=南, m）。 */
export interface PileSource {
  x: number;
  z: number;
  /** 積む体積(m³)。空隙を含むかさ体積（{@link bulkVolume} で求める）。 */
  volume: number;
}

/** 投入点ごとの結果。 */
export interface PileStats {
  /** その投入点が受け持つ範囲での山の表面の最高点（ローカル Y, m）。堆積がなければ NaN。 */
  apexY: number;
  /** 投入点の地表からの頂上の高さ(m)。apexY − 投入点セルの地表。 */
  apexHeight: number;
  /** 受け持ち範囲で堆積のあるセルの面積(m²)。 */
  area: number;
  /** 受け持ち範囲に実際に積んだ体積(m³)。 */
  volume: number;
  /** 堆積のあるセルの連結成分の番号。同じ番号の投入点は一つの山としてつながっている。-1 は堆積なし。 */
  group: number;
}

export interface PileResult {
  /** 各セルの堆積の厚さ(m)。格子と同じ並び（行優先）。 */
  thickness: Float32Array;
  /** 投入点ごとの結果（入力と同じ順）。 */
  piles: PileStats[];
  /** 実際に積んだ体積の合計(m³)。 */
  totalVolume: number;
  /** 各投入点の頂上の高さ（ローカル Y, m）。成長計算に使う。 */
  apex: Float64Array;
}

export interface DepositOptions {
  /** 投入点ごとの体積の相対誤差の目標（既定 0.002）。 */
  perPileTolerance?: number;
  /** 総体積の相対誤差の目標（既定 0.001）。 */
  totalTolerance?: number;
  /** 山ごとの体積の調整の反復回数の上限（既定 4）。 */
  maxIterations?: number;
}

/** 個数から山のかさ体積(m³)を求める。count × unitVolume ÷ packingFraction。 */
export function bulkVolume(count: number, unitVolume: number, packingFraction: number): number {
  if (!(packingFraction > 0 && packingFraction <= 1)) {
    throw new RangeError('packingFraction は 0 より大きく 1 以下で指定してください');
  }
  if (!(count >= 0) || !(unitVolume >= 0)) throw new RangeError('count と unitVolume は 0 以上で指定してください');
  return (count * unitVolume) / packingFraction;
}

/** 平らな地面に積んだ円錐の高さ H = (3V·tan²θ/π)^(1/3)。 */
export function coneHeight(volume: number, angleDeg: number): number {
  const t = Math.tan((angleDeg * Math.PI) / 180);
  return Math.cbrt((3 * volume * t * t) / Math.PI);
}

// ---------------------------------------------------------------------------
// 内部: priority-flood

/** 16 近傍のオフセットと、通過する中間セル（斜め・桂馬で角をすり抜けないため）。 */
interface Step {
  dc: number;
  dr: number;
  len: number;
  /** 中間セルのオフセット（0〜2 個）。 */
  mids: Array<[number, number]>;
}

function buildSteps(): Step[] {
  const steps: Step[] = [];
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const a = Math.abs(dc);
      const b = Math.abs(dr);
      if ((a === 0 && b === 0) || a + b > 3 || (a === 2 && b !== 1) || (b === 2 && a !== 1)) continue;
      const sc = Math.sign(dc);
      const sr = Math.sign(dr);
      const mids: Array<[number, number]> = [];
      if (a === 1 && b === 1) {
        mids.push([sc, 0], [0, sr]);
      } else if (a === 2) {
        mids.push([sc, 0], [sc, sr]);
      } else if (b === 2) {
        mids.push([0, sr], [sc, sr]);
      }
      steps.push({ dc, dr, len: Math.hypot(dc, dr), mids });
    }
  }
  return steps;
}

const STEPS = buildSteps();

/** 浮動小数キーの最大ヒープ（キー, セル番号）。 */
class MaxHeap {
  keys = new Float64Array(1024);
  vals = new Int32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    const keys = this.keys;
    const vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pk = keys[p] as number;
      if (pk >= key) break;
      keys[i] = pk;
      vals[i] = vals[p] as number;
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** 先頭を取り出し、そのセル番号を返す（キーは lastKey）。 */
  lastKey = 0;
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const topVal = vals[0] as number;
    this.lastKey = keys[0] as number;
    const n = --this.size;
    if (n > 0) {
      const key = keys[n] as number;
      const val = vals[n] as number;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        const r = c + 1;
        if (r < n && (keys[r] as number) > (keys[c] as number)) c = r;
        if ((keys[c] as number) <= key) break;
        keys[i] = keys[c] as number;
        vals[i] = vals[c] as number;
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return topVal;
  }
}

interface SourceCell {
  /** 投入点の位置（格子の列・行単位の連続値。セル中心は整数 + 0.5）。 */
  u: number;
  v: number;
  /** 投入点を含むセルの地表の高さ。 */
  base: number;
  inside: boolean;
}

/** 保存した表面（到達したセルだけの疎な表現）。 */
interface FloodState {
  cells: Int32Array;
  level: Float64Array;
  owner: Int32Array;
}

/** 計算の作業領域。格子ごとに使い回す。 */
class Flood {
  readonly n: number;
  readonly level: Float64Array;
  readonly owner: Int32Array;
  readonly done: Uint8Array;
  readonly touched: Int32Array;
  /** 連結成分の番号（label() が書く）。堆積のないセルは -1。 */
  readonly labels: Int32Array;
  private readonly stack: Int32Array;
  private readonly aux: Float64Array;
  touchedCount = 0;
  private readonly heap = new MaxHeap();
  private readonly offsets: Int32Array;

  constructor(
    readonly grid: HeightGrid,
    readonly tanTheta: number,
  ) {
    this.n = grid.width * grid.height;
    this.level = new Float64Array(this.n).fill(-Infinity);
    this.owner = new Int32Array(this.n).fill(-1);
    this.done = new Uint8Array(this.n);
    this.touched = new Int32Array(this.n);
    this.labels = new Int32Array(this.n).fill(-1);
    this.aux = new Float64Array(this.n).fill(-Infinity);
    this.stack = new Int32Array(this.n);
    this.offsets = new Int32Array(STEPS.length * 3);
    STEPS.forEach((s, k) => {
      this.offsets[k * 3] = s.dr * grid.width + s.dc;
      this.offsets[k * 3 + 1] = s.mids[0] ? s.mids[0][1] * grid.width + s.mids[0][0] : 0;
      this.offsets[k * 3 + 2] = s.mids[1] ? s.mids[1][1] * grid.width + s.mids[1][0] : 0;
    });
  }

  private reset(): void {
    const { level, owner, done, touched } = this;
    for (let k = 0; k < this.touchedCount; k++) {
      const c = touched[k] as number;
      level[c] = -Infinity;
      owner[c] = -1;
      done[c] = 0;
      this.labels[c] = -1;
    }
    this.touchedCount = 0;
  }

  private offer(c: number, value: number, who: number): void {
    if (value <= (this.level[c] as number)) return;
    if ((this.level[c] as number) === -Infinity) this.touched[this.touchedCount++] = c;
    this.level[c] = value;
    this.owner[c] = who;
    this.heap.push(value, c);
  }

  /** 頂上の高さ apex[i] から表面 level を求める。apex が -Infinity の投入点は無視する。 */
  run(sources: SourceCell[], apex: Float64Array): void {
    this.reset();
    const { grid, tanTheta, level, owner, done, offsets } = this;
    const g = grid.data;
    const w = grid.width;
    const h = grid.height;
    const cs = grid.cellSize;
    const heap = this.heap;
    heap.clear();

    // 投入点の近く（半径 1.5 セル）は投入点からのユークリッド距離で初期化する。
    const SEED_R = 1.5;
    sources.forEach((s, i) => {
      const a = apex[i] as number;
      if (!s.inside || !(a > -Infinity)) return;
      const c0 = Math.max(0, Math.floor(s.u - SEED_R));
      const c1 = Math.min(w - 1, Math.floor(s.u + SEED_R));
      const r0 = Math.max(0, Math.floor(s.v - SEED_R));
      const r1 = Math.min(h - 1, Math.floor(s.v + SEED_R));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(c + 0.5 - s.u, r + 0.5 - s.v);
          if (d > SEED_R) continue;
          const idx = r * w + c;
          const val = a - tanTheta * d * cs;
          if (val >= (g[idx] as number)) this.offer(idx, val, i);
        }
      }
    });

    const nSteps = STEPS.length;
    const stepLen = new Float64Array(nSteps);
    const stepDc = new Int32Array(nSteps);
    const stepDr = new Int32Array(nSteps);
    const nMids = new Int32Array(nSteps);
    const midDrop = new Float64Array(nSteps * 2);
    STEPS.forEach((s, k) => {
      stepLen[k] = tanTheta * s.len * cs;
      s.mids.forEach((m, j) => {
        midDrop[k * 2 + j] = tanTheta * Math.hypot(m[0], m[1]) * cs;
      });
      stepDc[k] = s.dc;
      stepDr[k] = s.dr;
      nMids[k] = s.mids.length;
    });

    while (heap.size > 0) {
      const c = heap.pop();
      const p = heap.lastKey;
      if (done[c] || p < (level[c] as number)) continue;
      done[c] = 1;
      const who = owner[c] as number;
      const row = (c / w) | 0;
      const col = c - row * w;
      const interior = col >= 2 && row >= 2 && col < w - 2 && row < h - 2;
      for (let k = 0; k < nSteps; k++) {
        if (!interior) {
          const nc = col + (stepDc[k] as number);
          const nr = row + (stepDr[k] as number);
          if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
        }
        const ni = c + (offsets[k * 3] as number);
        if (done[ni]) continue;
        const val = p - (stepLen[k] as number);
        if (val <= (level[ni] as number) || val < (g[ni] as number)) continue;
        if ((nMids[k] as number) > 0) {
          // 中間セルが、そこに届く表面より高い（露出した建物）なら角をすり抜けない。
          if (
            (g[c + (offsets[k * 3 + 1] as number)] as number) > p - (midDrop[k * 2] as number) ||
            (g[c + (offsets[k * 3 + 2] as number)] as number) > p - (midDrop[k * 2 + 1] as number)
          ) {
            continue;
          }
        }
        this.offer(ni, val, who);
      }
    }
  }

  /**
   * 堆積のあるセル（表面 > 地表）を 8 近傍の連結成分に分け、labels に番号を書く。
   * 戻り値は成分ごとの体積(m³)。
   */
  label(): { volume: Float64Array } {
    const { labels, touched, level, grid } = this;
    const g = grid.data;
    const w = grid.width;
    const h = grid.height;
    const area = grid.cellSize * grid.cellSize;
    for (let k = 0; k < this.touchedCount; k++) labels[touched[k] as number] = -1;
    const stack = this.stack;
    const vols: number[] = [];
    for (let k = 0; k < this.touchedCount; k++) {
      const start = touched[k] as number;
      if ((labels[start] as number) >= 0 || !((level[start] as number) > (g[start] as number))) continue;
      const id = vols.length;
      let vol = 0;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = id;
      while (sp > 0) {
        const c = stack[--sp] as number;
        vol += ((level[c] as number) - (g[c] as number)) * area;
        const row = (c / w) | 0;
        const col = c - row * w;
        for (let dr = -1; dr <= 1; dr++) {
          const nr = row + dr;
          if (nr < 0 || nr >= h) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const nc = col + dc;
            if (nc < 0 || nc >= w) continue;
            const ni = nr * w + nc;
            if ((labels[ni] as number) < 0 && (level[ni] as number) > (g[ni] as number)) {
              labels[ni] = id;
              stack[sp++] = ni;
            }
          }
        }
      }
      vols.push(vol);
    }
    return { volume: Float64Array.from(vols) };
  }

  /** 投入点の位置のセル（堆積がなければ近くのシードセル）の成分番号。なければ -1。 */
  groupAt(s: SourceCell): number {
    if (!s.inside) return -1;
    const w = this.grid.width;
    const col = Math.floor(s.u);
    const row = Math.floor(s.v);
    const l = this.labels[row * w + col] as number;
    if (l >= 0) return l;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= this.grid.height || c >= w) continue;
        const v = this.labels[r * w + c] as number;
        if (v >= 0) return v;
      }
    }
    return -1;
  }

  /** 現在の表面（到達したセルの表面と受け持ち）を保存する。 */
  snapshot(): FloodState {
    const count = this.touchedCount;
    const cells = this.touched.slice(0, count);
    const level = new Float64Array(count);
    const owner = new Int32Array(count);
    for (let k = 0; k < count; k++) {
      const c = cells[k] as number;
      level[k] = this.level[c] as number;
      owner[k] = this.owner[c] as number;
    }
    return { cells, level, owner };
  }

  /**
   * 二つの状態 lo（体積が足りない）と hi（体積が多すぎる）を
   * 表面 = max(lo の表面, hi の表面 − δ) で合成し、総体積が target になる δ を二分法で求めて
   * 現在の状態にする。hi の表面を一様に下げても勾配は変わらず、max を取っても
   * 隣接セル間の勾配は tanθ を超えない（屋上を越えた先の山を部分的に満たすのに相当）。
   */
  blend(lo: FloodState, hi: FloodState, target: number): number {
    const g = this.grid.data;
    const area = this.grid.cellSize * this.grid.cellSize;
    const aux = this.aux;
    for (let k = 0; k < lo.cells.length; k++) aux[lo.cells[k] as number] = lo.level[k] as number;
    const volumeAt = (delta: number): number => {
      let v = 0;
      for (let k = 0; k < hi.cells.length; k++) {
        const c = hi.cells[k] as number;
        const s = Math.max(aux[c] as number, (hi.level[k] as number) - delta);
        const t = s - (g[c] as number);
        if (t > 0) v += t;
      }
      return v * area;
    };
    let dLo = 0;
    let dHi = 1;
    while (volumeAt(dHi) > target && dHi < 1e6) dHi *= 2;
    for (let it = 0; it < 60; it++) {
      const mid = (dLo + dHi) / 2;
      if (volumeAt(mid) > target) dLo = mid;
      else dHi = mid;
      if (dHi - dLo < 1e-6) break;
    }
    const delta = (dLo + dHi) / 2;

    this.reset();
    const loOwner = new Map<number, number>();
    for (let k = 0; k < lo.cells.length; k++) loOwner.set(lo.cells[k] as number, lo.owner[k] as number);
    for (let k = 0; k < hi.cells.length; k++) {
      const c = hi.cells[k] as number;
      const a = aux[c] as number;
      const b = (hi.level[k] as number) - delta;
      this.touched[this.touchedCount++] = c;
      if (a >= b) {
        this.level[c] = a;
        this.owner[c] = loOwner.get(c) ?? (hi.owner[k] as number);
      } else {
        this.level[c] = b;
        this.owner[c] = hi.owner[k] as number;
      }
    }
    for (let k = 0; k < lo.cells.length; k++) aux[lo.cells[k] as number] = -Infinity;
    return volumeAt(delta);
  }

  /** 投入点ごとの体積（受け持ちセルの厚さ × 面積）を out に書く。 */
  volumes(out: Float64Array): number {
    out.fill(0);
    const g = this.grid.data;
    const area = this.grid.cellSize * this.grid.cellSize;
    let total = 0;
    for (let k = 0; k < this.touchedCount; k++) {
      const c = this.touched[k] as number;
      const t = (this.level[c] as number) - (g[c] as number);
      if (t > 0) {
        const v = t * area;
        const o = this.owner[c] as number;
        out[o] = (out[o] as number) + v;
        total += v;
      }
    }
    return total;
  }

  /** 現在の表面から厚さを書き出す（Float32）。 */
  writeThickness(out: Float32Array): void {
    const g = this.grid.data;
    for (let k = 0; k < this.touchedCount; k++) {
      const c = this.touched[k] as number;
      const t = (this.level[c] as number) - (g[c] as number);
      out[c] = t > 0 ? t : 0;
    }
  }
}

function prepareSources(grid: HeightGrid, sources: readonly PileSource[]): SourceCell[] {
  return sources.map((s) => {
    const u = (s.x - grid.originX) / grid.cellSize;
    const v = (s.z - grid.originZ) / grid.cellSize;
    const col = Math.floor(u);
    const row = Math.floor(v);
    const inside = col >= 0 && row >= 0 && col < grid.width && row < grid.height;
    const base = inside ? (grid.data[row * grid.width + col] as number) : 0;
    return { u, v, base, inside };
  });
}

/**
 * 共通倍率 λ で頂上の高さ（地表からの高さ）を縮めて、総体積を target に合わせる。
 * 表面は λ について単調増加なので、括弧付きの割線/二分法で解ける。
 */
function solveScale(
  flood: Flood,
  src: SourceCell[],
  heights: Float64Array,
  target: number,
  tol: number,
  lambda0: number,
  scratch: Float64Array,
  maxEval = 8,
): { lambda: number; total: number } {
  const apex = new Float64Array(heights.length);
  const evalAt = (lambda: number): number => {
    for (let i = 0; i < heights.length; i++) {
      const hgt = heights[i] as number;
      apex[i] = hgt > 0 ? (src[i] as SourceCell).base + lambda * hgt : -Infinity;
    }
    flood.run(src, apex);
    return flood.volumes(scratch);
  };
  if (target <= 0) {
    evalAt(0);
    return { lambda: 0, total: 0 };
  }
  let lo = 0;
  let hi = Infinity;
  let loState: FloodState = { cells: new Int32Array(0), level: new Float64Array(0), owner: new Int32Array(0) };
  let hiState: FloodState | null = null;
  let lambda = lambda0;
  let total = 0;
  let prevLambda = 0;
  let prevTotal = 0;
  // 体積は λ について単調だが、山が屋上を越えるたびに不連続に跳ぶ。
  // 数回の割線/二分法で括弧を狭め、残りは lo/hi の合成（blend）で連続に合わせる。
  for (let it = 0; it < maxEval; it++) {
    total = evalAt(lambda);
    if (Math.abs(total - target) <= tol * target) return { lambda, total };
    if (total < target) {
      lo = lambda;
      loState = flood.snapshot();
    } else {
      hi = lambda;
      hiState = flood.snapshot();
    }
    if (hiState && lo > 0 && (hi - lo) / hi < 1e-3) break;
    // 体積 ∝ λ^e として、e を直前の 2 点から推定する（初回は円錐の e = 3）。
    // 括弧の外に出たら二分法。
    let e = 3;
    if (prevLambda > 0 && prevTotal > 0 && total > 0 && prevLambda !== lambda) {
      const est = Math.log(total / prevTotal) / Math.log(lambda / prevLambda);
      if (Number.isFinite(est)) e = Math.min(8, Math.max(0.5, est));
    }
    prevLambda = lambda;
    prevTotal = total;
    let next = total > 0 ? lambda * Math.pow(target / total, 1 / e) : lambda * 2;
    if (!(next > lo && next < hi)) next = hi === Infinity ? Math.max(lambda * 2, lo * 2) : (lo + hi) / 2;
    lambda = next;
  }
  if (!hiState) return { lambda, total };
  total = flood.blend(loState, hiState, target);
  return { lambda: hi, total };
}

/**
 * 地表の高さ格子に、複数の投入点から山を積む。
 *
 * @param ground 地表（建物の屋上を含む）の高さ格子
 * @param sources 投入点（位置と体積）。格子の外の投入点は体積 0 として扱う。
 * @param angleDeg 安息角(度)。0 より大きく 90 未満。
 */
export function depositPiles(
  ground: HeightGrid,
  sources: readonly PileSource[],
  angleDeg: number,
  options: DepositOptions = {},
): PileResult {
  if (!(angleDeg > 0 && angleDeg < 90)) throw new RangeError('angleDeg は 0〜90 度の範囲で指定してください');
  const perTol = options.perPileTolerance ?? 0.002;
  const totalTol = options.totalTolerance ?? 0.001;
  const maxIter = options.maxIterations ?? 4;
  const tanTheta = Math.tan((angleDeg * Math.PI) / 180);
  const flood = new Flood(ground, tanTheta);
  const src = prepareSources(ground, sources);
  const n = sources.length;

  const targets = new Float64Array(n);
  let targetTotal = 0;
  src.forEach((s, i) => {
    const v = (sources[i] as PileSource).volume;
    targets[i] = s.inside && v > 0 ? v : 0;
    targetTotal += targets[i] as number;
  });

  // 地表からの頂上の高さ。初期値は平地の円錐。
  const heights = new Float64Array(n);
  for (let i = 0; i < n; i++) heights[i] = (targets[i] as number) > 0 ? coneHeight(targets[i] as number, angleDeg) : 0;

  const owned = new Float64Array(n);
  const apex = new Float64Array(n);
  // 山ごと（連結成分ごと）に体積を合わせる。つながった山は投入点の目標の合計に合わせ、
  // その成分に属する投入点の高さを共通の比で伸縮する（体積 ∝ 高さ³）。
  let total = 0;
  let converged = false;
  const srcGroup = new Int32Array(n);
  for (let it = 0; it < maxIter; it++) {
    for (let i = 0; i < n; i++) {
      const hgt = heights[i] as number;
      apex[i] = hgt > 0 ? (src[i] as SourceCell).base + hgt : -Infinity;
    }
    flood.run(src, apex);
    const groups = flood.label();
    const gVol = groups.volume;
    const gTarget = new Float64Array(gVol.length + n);
    total = 0;
    for (let k = 0; k < gVol.length; k++) total += gVol[k] as number;
    for (let i = 0; i < n; i++) {
      const g = flood.groupAt(src[i] as SourceCell);
      // 堆積のない投入点は専用の番号（gVol.length + i, 体積 0）。
      const id = g >= 0 ? g : gVol.length + i;
      srcGroup[i] = id;
      gTarget[id] = (gTarget[id] as number) + (targets[i] as number);
    }
    let worst = 0;
    for (let id = 0; id < gTarget.length; id++) {
      const t = gTarget[id] as number;
      if (t > 0) worst = Math.max(worst, Math.abs((id < gVol.length ? (gVol[id] as number) : 0) - t) / t);
    }
    if (worst <= perTol) {
      converged = true;
      break;
    }
    for (let i = 0; i < n; i++) {
      if ((targets[i] as number) <= 0) continue;
      const id = srcGroup[i] as number;
      const o = id < gVol.length ? (gVol[id] as number) : 0;
      const t = gTarget[id] as number;
      const ratio = o > 0 ? Math.min(8, Math.max(0.125, t / o)) : 8;
      heights[i] = (heights[i] as number) * Math.cbrt(ratio);
    }
  }

  // 収束しなかった場合は総体積を共通倍率で合わせる。
  if (!converged || Math.abs(total - targetTotal) > totalTol * targetTotal) {
    const res = solveScale(flood, src, heights, targetTotal, totalTol, 1, owned);
    total = res.total;
    for (let i = 0; i < n; i++) {
      const hgt = (heights[i] as number) * res.lambda;
      heights[i] = hgt;
      apex[i] = hgt > 0 ? (src[i] as SourceCell).base + hgt : -Infinity;
    }
    flood.label();
  }

  const thickness = new Float32Array(flood.n);
  flood.writeThickness(thickness);

  const cellArea = ground.cellSize * ground.cellSize;
  const piles: PileStats[] = src.map(() => ({
    apexY: Number.NaN,
    apexHeight: Number.NaN,
    area: 0,
    volume: 0,
    group: -1,
  }));
  for (let k = 0; k < flood.touchedCount; k++) {
    const c = flood.touched[k] as number;
    const t = thickness[c] as number;
    if (!(t > 0)) continue;
    const p = piles[flood.owner[c] as number] as PileStats;
    const y = flood.level[c] as number;
    if (!(p.apexY >= y)) p.apexY = y;
    p.area += cellArea;
    p.volume += t * cellArea;
  }
  piles.forEach((p, i) => {
    const s = src[i] as SourceCell;
    if (p.area > 0) p.apexHeight = p.apexY - s.base;
    // 他の投入点の山に埋もれた投入点も、その位置の山の番号を持つ。
    p.group = flood.groupAt(s);
  });

  return { thickness, piles, totalVolume: total, apex };
}

// ---------------------------------------------------------------------------
// 成長

export interface PileGrowth {
  /** 段階の体積比（0 から 1 まで昇順。先頭は 0、末尾は 1）。 */
  readonly fractions: Float64Array;
  /** 最終状態の結果。 */
  readonly final: PileResult;
  /** 格納している範囲（最終状態で堆積のある範囲の外接矩形）。 */
  readonly bounds: { col0: number; row0: number; col1: number; row1: number };
  /**
   * 進捗 t（0〜1, 体積比）の山の厚さ。段階の間は線形補間するので、
   * 体積は t に比例し、各セルの厚さは t について単調非減少になる。
   */
  thicknessAt(t: number, out?: Float32Array): Float32Array;
}

export interface GrowthOptions extends DepositOptions {
  /** 事前に計算する段階の数（0 を除く。既定 12）。 */
  stages?: number;
}

/**
 * 体積が 0 から最終値まで増える途中の山の形を事前に計算する。
 *
 * 段階 k（体積比 k/stages）は、最終状態の各投入点の頂上の高さ（地表から）に
 * 共通倍率 λ を掛けた形で、総体積が比に合うよう λ を解く。
 * λ が増えれば表面はどこでも下がらないので、段階間で厚さは単調に増える。
 */
export function computePileGrowth(
  ground: HeightGrid,
  sources: readonly PileSource[],
  angleDeg: number,
  options: GrowthOptions = {},
): PileGrowth {
  const stages = Math.max(1, Math.floor(options.stages ?? 12));
  const final = depositPiles(ground, sources, angleDeg, options);
  const totalTol = options.totalTolerance ?? 0.001;
  const w = ground.width;

  // 最終状態の堆積の外接矩形（それより前の段階はこの内側に収まる）。
  let col0 = w;
  let row0 = ground.height;
  let col1 = -1;
  let row1 = -1;
  for (let c = 0; c < final.thickness.length; c++) {
    if ((final.thickness[c] as number) > 0) {
      const r = (c / w) | 0;
      const cc = c - r * w;
      if (cc < col0) col0 = cc;
      if (cc > col1) col1 = cc;
      if (r < row0) row0 = r;
      if (r > row1) row1 = r;
    }
  }
  if (col1 < 0) {
    col0 = 0;
    row0 = 0;
    col1 = -1;
    row1 = -1;
  }
  const bw = col1 - col0 + 1;
  const bh = row1 - row0 + 1;
  const crop = (full: Float32Array): Float32Array => {
    const out = new Float32Array(bw * bh);
    for (let r = 0; r < bh; r++) out.set(full.subarray((row0 + r) * w + col0, (row0 + r) * w + col0 + bw), r * bw);
    return out;
  };

  const tanTheta = Math.tan((angleDeg * Math.PI) / 180);
  const flood = new Flood(ground, tanTheta);
  const src = prepareSources(ground, sources);
  const heights = new Float64Array(sources.length);
  src.forEach((s, i) => {
    const a = final.apex[i] as number;
    heights[i] = a > -Infinity ? a - s.base : 0;
  });
  const scratch = new Float64Array(sources.length);

  const fractions = new Float64Array(stages + 1);
  const layers: Float32Array[] = [new Float32Array(bw * bh)];
  const full = new Float32Array(flood.n);
  for (let k = 1; k < stages; k++) {
    const f = k / stages;
    fractions[k] = f;
    solveScale(flood, src, heights, f * final.totalVolume, totalTol, Math.cbrt(f), scratch);
    full.fill(0);
    flood.writeThickness(full);
    const layer = crop(full);
    // 数値誤差で前段より薄くならないようにする。
    const prev = layers[k - 1] as Float32Array;
    for (let j = 0; j < layer.length; j++) if ((layer[j] as number) < (prev[j] as number)) layer[j] = prev[j] as number;
    layers.push(layer);
  }
  fractions[stages] = 1;
  layers.push(crop(final.thickness));

  const thicknessAt = (tIn: number, out?: Float32Array): Float32Array => {
    const t = Math.min(1, Math.max(0, Number.isFinite(tIn) ? tIn : 0));
    const res = out ?? new Float32Array(w * ground.height);
    if (out) res.fill(0);
    if (bw <= 0 || bh <= 0) return res;
    let k = Math.min(stages - 1, Math.floor(t * stages));
    while (k > 0 && (fractions[k] as number) > t) k--;
    const f0 = fractions[k] as number;
    const f1 = fractions[k + 1] as number;
    const a = f1 > f0 ? (t - f0) / (f1 - f0) : 1;
    const l0 = layers[k] as Float32Array;
    const l1 = layers[k + 1] as Float32Array;
    for (let r = 0; r < bh; r++) {
      const base = (row0 + r) * w + col0;
      for (let c = 0; c < bw; c++) {
        const j = r * bw + c;
        const v0 = l0[j] as number;
        res[base + c] = v0 + ((l1[j] as number) - v0) * a;
      }
    }
    return res;
  };

  return { fractions, final, bounds: { col0, row0, col1, row1 }, thicknessAt };
}
