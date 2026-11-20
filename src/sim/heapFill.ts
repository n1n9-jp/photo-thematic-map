/**
 * 堆積の山に自転車を詰める（描画に依存しない純粋な計算）。
 *
 * 入力は地表の高さ格子（{@link HeightGrid}）と、その上の堆積の厚さ（{@link PileResult.thickness}）。
 * 山の体積 V の中に、台数 N を一様な密度 N / V で置く（N × 1台のかさ体積 ≒ V になるよう山を作る前提）。
 *
 * 方式:
 * 1. 台数の割り当て: 堆積のある各セルの柱（地表から山の表面まで）の体積に比例した期待台数を、
 *    系統抽出（累積和を 1 刻みで切る）で整数に丸める。合計は台数に正確に一致する。
 *    表層だけを置く指定では、柱のうち表面から一定の深さ（法線方向）までの部分の体積を使う。
 * 2. 位置: 柱の中で水平は一様乱数、高さは柱を台数で等分した層の中の乱数（層別抽出）。
 *    これが自転車の中心（車体の座標の CENTER）の位置になる。
 * 3. 向き: 表面から `alignDepth` より浅い自転車は、表面の法線に車体の横方向（+Z）を寄せて寝かせ、
 *    車体の面内の回転はばらばらにする（一部は斜面にもたれて立つ）。深い自転車は一様にランダムな向き。
 * 4. 収まりの調整: 車体の外形の代表点（{@link BIKE_HULL}）を回して、すべての点が地表より上、
 *    山の表面 + `topTolerance` より下に収まる中心の高さの範囲を求め、その範囲に高さを寄せる。
 *    範囲がなければ向きを引き直す（`attempts` 回まで）。それでも収まらなければ、
 *    最も収まりのよい向きで地表より上に置く（このとき上端が表面から出ることがある。`stats.overTop` で数える）。
 *    建物の壁に当たる点（その点の地表が中心より高い）は、最後の手段では制約から外す（壁にめり込む）。
 * 5. 順序: 山が成長する途中で自転車の中心が堆積に覆われる進捗 t（0〜1）の順に並べる。
 *    `growth`（{@link computePileGrowth}）を渡すとその段階の厚さから t を求める。渡さなければ、
 *    最終の表面からの鉛直の深さが深い順にする（一つの投入点の山の成長は表面が一様に上がるのに近いので、
 *    深い自転車ほど先に覆われる）。先頭の k 台は k 台ぶんの小さな山の形になる。
 *
 * 結果は TypedArray。位置は車体の原点（接地面の中央）で、`BicycleInstances` の positions にそのまま使える。
 */
import type { HeightGrid } from './heightGrid';
import type { PileGrowth } from './pile';
import { mulberry32 } from './syntheticCity';

/** 車体の座標での自転車の中心（原点は接地面の中央、+X 前、+Y 上、+Z 右）。 */
export const BIKE_CENTER: readonly [number, number, number] = [0, 0.5, 0];

/**
 * 車体の外形の代表点（車体の座標, m）。ママチャリの寸法（`src/scene/bicycle/geometry.ts` の
 * `BIKE_DIMENSIONS`）に合わせてある: 車輪の外周、ハンドルの両端、前かごの角、サドル、ペダル、荷台、スタンド。
 */
export const BIKE_HULL: readonly (readonly [number, number, number])[] = (() => {
  const pts: [number, number, number][] = [];
  for (const ax of [-0.55, 0.55]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pts.push([ax + Math.cos(a) * 0.33, 0.33 + Math.sin(a) * 0.33, 0]);
    }
  }
  for (const s of [-1, 1]) {
    pts.push([0.1, 1.0, 0.29 * s]); // ハンドルの端
    pts.push([0.87, 0.71, 0.19 * s], [0.87, 0.95, 0.19 * s], [0.5, 0.71, 0.19 * s], [0.5, 0.95, 0.19 * s]); // かご
    pts.push([-0.29, 0.94, 0.1 * s]); // サドルの左右
    pts.push([-0.08 - 0.12 * s, 0.27 + 0.12 * s, 0.21 * s]); // ペダル
    pts.push([-0.86, 0.75, 0.075 * s]); // 荷台の後ろ
    pts.push([-0.67, 0.01, 0.13 * s]); // スタンドの足
  }
  pts.push([0.31, 1.03, 0], [-0.43, 0.94, 0], [-0.15, 0.94, 0]);
  return pts;
})();

export interface HeapFillParams {
  /** 地表（建物の屋上を含む）の高さ格子。欠損は NaN。 */
  ground: HeightGrid;
  /** 堆積の厚さ（`PileResult.thickness`、格子と同じ並び）。 */
  thickness: Float32Array;
  /** 山全体が表す台数。 */
  count: number;
  /** 1台あたりのかさ体積(m³)。既定 0.35。山の体積との食い違いの確認（`volumeMismatch`）に使う。 */
  unitVolume?: number;
  /** 乱数の種。 */
  seed: number;
  /** 'full' は全台を詰める（既定）、'surface' は表面から `surfaceDepth` までに入る自転車だけを置く。 */
  mode?: 'full' | 'surface';
  /** 表層だけを置くときの深さ（法線方向, m）。既定 1.5。 */
  surfaceDepth?: number;
  /** 成長の途中の形。渡すと並び順を成長の進捗から求める。 */
  growth?: PileGrowth;
  /** 表面からこの深さ(m)より浅い自転車を斜面に沿って寝かせる。既定 1.0。 */
  alignDepth?: number;
  /** 自転車の上端が山の表面から出てよい高さ(m)。既定 0.3。 */
  topTolerance?: number;
  /** 収まる向きを探す回数。既定 8。 */
  attempts?: number;
}

export interface HeapFillStats {
  /** 収まる向きが見つからず、上端が表面 + topTolerance より上に出た台数。 */
  overTop: number;
  /** そのときの、はみ出しの最大(m)。 */
  maxOverTop: number;
  /** 建物の壁に当たる点を制約から外して置いた台数。 */
  wallContacts: number;
  /** 地表より下にある代表点の最大の深さ(m)（壁にめり込んだ点は除く）。0 なら潜っていない。 */
  maxBelowGround: number;
  /** 計算時間(ms)。 */
  ms: number;
}

export interface HeapFillResult {
  /** 'full' または 'surface'。 */
  mode: 'full' | 'surface';
  /** 山全体が表す台数（入力の台数）。 */
  representedCount: number;
  /** 実際に配置した台数（'full' では representedCount と等しい）。 */
  count: number;
  /** 車体の原点の位置（ローカル座標 m）。長さ 3 × count。成長の順。 */
  positions: Float32Array;
  /** 回転の四元数 (x, y, z, w)。長さ 4 × count。 */
  quaternions: Float32Array;
  /** 自転車の中心（{@link BIKE_CENTER} を回して置いた位置）。長さ 3 × count。 */
  centers: Float32Array;
  /** 中心の、山の表面からの深さ（法線方向, m, 0 以上）。長さ count。 */
  depths: Float32Array;
  /** 成長の進捗（0〜1）のうち、その自転車の中心が堆積に覆われる値。昇順。長さ count。 */
  arrivals: Float32Array;
  /** 山の体積(m³)（厚さの合計 × セルの面積）。 */
  volume: number;
  /** 実際の密度から求めた1台あたりの体積 volume / representedCount (m³)。 */
  effectiveUnitVolume: number;
  /** 山の体積と 台数 × unitVolume の相対的な食い違い（volume / (count × unitVolume) − 1）。 */
  volumeMismatch: number;
  stats: HeapFillStats;
}

// ---------------------------------------------------------------------------
// 四元数（x, y, z, w）

type Quat = [number, number, number, number];

function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function qAxisAngle(x: number, y: number, z: number, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/** 単位ベクトル from を to へ回す四元数。 */
function qFromUnitVectors(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): Quat {
  const d = fx * tx + fy * ty + fz * tz;
  if (d < -0.999999) {
    // 反対向き: from に直交する軸で 180°
    const [ox, oy, oz] = Math.abs(fx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const ax = fy * oz - fz * oy;
    const ay = fz * ox - fx * oz;
    const az = fx * oy - fy * ox;
    const l = Math.hypot(ax, ay, az);
    return [ax / l, ay / l, az / l, 0];
  }
  const q: Quat = [fy * tz - fz * ty, fz * tx - fx * tz, fx * ty - fy * tx, 1 + d];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** 一様にランダムな回転（Shoemake）。 */
function qRandom(rng: () => number): Quat {
  const u1 = rng();
  const u2 = rng() * Math.PI * 2;
  const u3 = rng() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

/** q で回した v を out に書く。 */
function qRotate(q: Quat, vx: number, vy: number, vz: number, out: Float64Array, o: number): void {
  const [qx, qy, qz, qw] = q;
  // v + 2 q.xyz × (q.xyz × v + w v)
  const cx = qy * vz - qz * vy + qw * vx;
  const cy = qz * vx - qx * vz + qw * vy;
  const cz = qx * vy - qy * vx + qw * vz;
  out[o] = vx + 2 * (qy * cz - qz * cy);
  out[o + 1] = vy + 2 * (qz * cx - qx * cz);
  out[o + 2] = vz + 2 * (qx * cy - qy * cx);
}

// ---------------------------------------------------------------------------
// 格子の参照

interface Surface {
  w: number;
  h: number;
  cs: number;
  ox: number;
  oz: number;
  ground: Float32Array;
  /** 山の表面の高さ（堆積のあるセルだけ。それ以外は NaN）。 */
  surf: Float32Array;
}

/** (x, z) を含むセルの番号。格子の外は -1。 */
function cellIndex(s: Surface, x: number, z: number): number {
  const c = Math.floor((x - s.ox) / s.cs);
  const r = Math.floor((z - s.oz) / s.cs);
  if (c < 0 || r < 0 || c >= s.w || r >= s.h) return -1;
  return r * s.w + c;
}

/**
 * 山の表面の高さを、まわりの4つのセルの中心から双線形に補間する（堆積のないセルは除いて重みを付け直す）。
 * 4つとも堆積がなければ NaN。
 */
function surfaceAt(s: Surface, x: number, z: number): number {
  const u = (x - s.ox) / s.cs - 0.5;
  const v = (z - s.oz) / s.cs - 0.5;
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const fu = u - c0;
  const fv = v - r0;
  let sum = 0;
  let wsum = 0;
  for (let dr = 0; dr <= 1; dr++) {
    const r = r0 + dr;
    if (r < 0 || r >= s.h) continue;
    const wr = dr ? fv : 1 - fv;
    for (let dc = 0; dc <= 1; dc++) {
      const c = c0 + dc;
      if (c < 0 || c >= s.w) continue;
      const val = s.surf[r * s.w + c] as number;
      if (Number.isNaN(val)) continue;
      const wgt = wr * (dc ? fu : 1 - fu);
      sum += val * wgt;
      wsum += wgt;
    }
  }
  return wsum > 1e-9 ? sum / wsum : Number.NaN;
}

/** セル k の表面の勾配の大きさの2乗（中心差分。堆積のない隣は自分の値で代用）。 */
function slope2(s: Surface, k: number, gradOut: Float64Array): number {
  const r = (k / s.w) | 0;
  const c = k - r * s.w;
  const here = s.surf[k] as number;
  const at = (cc: number, rr: number): number => {
    if (cc < 0 || rr < 0 || cc >= s.w || rr >= s.h) return here;
    const val = s.surf[rr * s.w + cc] as number;
    return Number.isNaN(val) ? here : val;
  };
  const gx = (at(c + 1, r) - at(c - 1, r)) / (2 * s.cs);
  const gz = (at(c, r + 1) - at(c, r - 1)) / (2 * s.cs);
  gradOut[0] = gx;
  gradOut[1] = gz;
  return gx * gx + gz * gz;
}

/**
 * 点 (x, y, z) の、山の表面からの深さ（法線方向, m, 0 以上）。表面の高さが求まらなければ 0。
 * 鉛直の深さに cos(勾配の角度) を掛けて法線方向に直す。
 */
function depthAt(s: Surface, x: number, y: number, z: number, grad: Float64Array): number {
  const top = surfaceAt(s, x, z);
  if (Number.isNaN(top)) return 0;
  const k = cellIndex(s, x, z);
  const g2 = k >= 0 && !Number.isNaN(s.surf[k] as number) ? slope2(s, k, grad) : 0;
  return Math.max(0, (top - y) / Math.sqrt(1 + g2));
}

function makeSurface(ground: HeightGrid, thickness: Float32Array): Surface {
  const n = ground.width * ground.height;
  if (thickness.length !== n) throw new RangeError('thickness の長さが格子と一致しません');
  const surf = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = thickness[k] as number;
    const g = ground.data[k] as number;
    surf[k] = t > 0 && !Number.isNaN(g) ? g + t : Number.NaN;
  }
  return { w: ground.width, h: ground.height, cs: ground.cellSize, ox: ground.originX, oz: ground.originZ, ground: ground.data, surf };
}

/**
 * 位置（中心）ごとの、与えた厚さの山の表面からの深さ（法線方向, m）。
 * 成長の途中の山（`growth.thicknessAt(t)`）に対する深さを求め直すのに使う。
 */
export function surfaceDepths(ground: HeightGrid, thickness: Float32Array, centers: Float32Array, count = centers.length / 3): Float32Array {
  const s = makeSurface(ground, thickness);
  const out = new Float32Array(count);
  const grad = new Float64Array(2);
  for (let i = 0; i < count; i++) {
    out[i] = depthAt(s, centers[i * 3] as number, centers[i * 3 + 1] as number, centers[i * 3 + 2] as number, grad);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 本体

/** 柱の地表よりこれ(m)以上高い地表は、建物の壁とみなす。 */
const WALL_STEP = 0.5;

/** 山に自転車を詰める。詳しい方式はファイル冒頭の説明を参照。 */
export function fillHeap(params: HeapFillParams): HeapFillResult {
  const t0 = performance.now();
  const { ground, thickness, seed } = params;
  const mode = params.mode ?? 'full';
  const N = Math.max(0, Math.floor(params.count));
  const unitVolume = params.unitVolume ?? 0.35;
  const shellDepth = params.surfaceDepth ?? 1.5;
  const alignDepth = params.alignDepth ?? 1.0;
  const topTol = params.topTolerance ?? 0.3;
  const attempts = Math.max(1, Math.floor(params.attempts ?? 8));
  const s = makeSurface(ground, thickness);
  const cs = s.cs;
  const cellArea = cs * cs;
  const ncell = s.w * s.h;
  const rng = mulberry32(seed);
  const grad = new Float64Array(2);

  // 1. セルごとの柱の範囲 [lo, top] と体積
  let volume = 0;
  const cells: number[] = [];
  for (let k = 0; k < ncell; k++) {
    if (!Number.isNaN(s.surf[k] as number)) {
      cells.push(k);
      volume += (thickness[k] as number) * cellArea;
    }
  }
  const density = volume > 0 ? N / volume : 0;
  const lo = new Float64Array(cells.length);
  const expected = new Float64Array(cells.length);
  cells.forEach((k, j) => {
    const g = s.ground[k] as number;
    const top = s.surf[k] as number;
    let bottom = g;
    if (mode === 'surface') {
      const dv = shellDepth * Math.sqrt(1 + slope2(s, k, grad));
      bottom = Math.max(g, top - dv);
    }
    lo[j] = bottom;
    expected[j] = density * (top - bottom) * cellArea;
  });

  // 系統抽出で整数の台数に丸める（合計は 'full' で N に正確に一致）
  const per = new Uint32Array(cells.length);
  let acc = rng();
  let placed = 0;
  for (let j = 0; j < cells.length; j++) {
    const before = Math.floor(acc);
    acc += expected[j] as number;
    const n = Math.floor(acc) - before;
    per[j] = n;
    placed += n;
  }
  if (mode === 'full' && cells.length > 0 && placed !== N) {
    // 浮動小数の誤差で 1 台ずれたら、最後のセルで合わせる
    const last = cells.length - 1;
    const fix = Math.max(0, (per[last] as number) + N - placed);
    placed += fix - (per[last] as number);
    per[last] = fix;
  }
  if (mode === 'full' && placed !== N) throw new Error(`台数を割り当てられません（山の体積 ${volume} m³）`);

  const centers = new Float32Array(placed * 3);
  const positions = new Float32Array(placed * 3);
  const quats = new Float32Array(placed * 4);
  const depths = new Float32Array(placed);
  const keys = new Float64Array(placed);

  const H = BIKE_HULL.length;
  const hull = new Float64Array(H * 3);
  const best = new Float64Array(H * 3);
  const rotated = new Float64Array(3);
  const stats: HeapFillStats = { overTop: 0, maxOverTop: 0, wallContacts: 0, maxBelowGround: 0, ms: 0 };
  const [cx0, cy0, cz0] = BIKE_CENTER;

  /**
   * 回した代表点から、中心の高さの範囲 [yMin, yMax] を求める。
   * wallLimit を与えると、地表がそれより高い点（建物の壁に当たる点）を制約から外す。
   */
  const range = (x: number, z: number, pts: Float64Array, wallLimit: number): [number, number] => {
    let yMin = -Infinity;
    let yMax = Infinity;
    for (let p = 0; p < H; p++) {
      const px = x + (pts[p * 3] as number);
      const py = pts[p * 3 + 1] as number;
      const pz = z + (pts[p * 3 + 2] as number);
      const k = cellIndex(s, px, pz);
      if (k < 0) continue;
      const g = s.ground[k] as number;
      if (Number.isNaN(g) || g > wallLimit) continue;
      if (g - py > yMin) yMin = g - py;
      let top = surfaceAt(s, px, pz);
      if (Number.isNaN(top)) top = g;
      if (top + topTol - py < yMax) yMax = top + topTol - py;
    }
    return [yMin + 0.005, yMax];
  };

  let i = 0;
  for (let j = 0; j < cells.length; j++) {
    const n = per[j] as number;
    if (n === 0) continue;
    const k = cells[j] as number;
    const r = (k / s.w) | 0;
    const c = k - r * s.w;
    const x0 = s.ox + c * cs;
    const z0 = s.oz + r * cs;
    const bottom = lo[j] as number;
    const top = s.surf[k] as number;
    const g2 = slope2(s, k, grad);
    // 表面の法線
    const nl = Math.sqrt(1 + g2);
    const nx = -(grad[0] as number) / nl;
    const ny = 1 / nl;
    const nz = -(grad[1] as number) / nl;
    const align = qFromUnitVectors(0, 0, 1, nx, ny, nz);
    const alignUp = qFromUnitVectors(0, 1, 0, nx, ny, nz);
    // 地表がこれより高い点は建物の壁とみなす（最後の手段で制約から外す）
    const wallLimit = (s.ground[k] as number) + WALL_STEP;
    for (let m = 0; m < n; m++, i++) {
      const x = x0 + rng() * cs;
      const z = z0 + rng() * cs;
      let y = bottom + ((m + rng()) / n) * (top - bottom);
      const d0 = depthAt(s, x, y, z, grad);
      let q: Quat = [0, 0, 0, 1];
      let bestQ: Quat = q;
      let bestGap = Infinity;
      let ok = false;
      for (let a = 0; a < attempts; a++) {
        if (d0 < alignDepth) {
          const u = rng();
          if (u < 0.8) {
            // 横倒し: 車体の横方向を法線に寄せ、面内の回転はばらばら、少し傾ける
            const spin = qAxisAngle(0, 0, 1, rng() * Math.PI * 2);
            const tilt = qAxisAngle(1, 0, 0, (rng() - 0.5) * 0.6);
            const flip = rng() < 0.5 ? qAxisAngle(0, 1, 0, Math.PI) : ([0, 0, 0, 1] as Quat);
            q = qMul(align, qMul(spin, qMul(tilt, flip)));
          } else {
            // 斜面にもたれて立つ
            const yaw = qAxisAngle(0, 1, 0, rng() * Math.PI * 2);
            const roll = qAxisAngle(1, 0, 0, (rng() < 0.5 ? -1 : 1) * (0.4 + rng() * 0.6));
            q = qMul(alignUp, qMul(yaw, roll));
          }
        } else {
          q = qRandom(rng);
        }
        for (let p = 0; p < H; p++) {
          const h = BIKE_HULL[p]!;
          qRotate(q, h[0] - cx0, h[1] - cy0, h[2] - cz0, hull, p * 3);
        }
        const [yMin, yMax] = range(x, z, hull, Infinity);
        if (yMin <= yMax) {
          y = Math.min(yMax, Math.max(yMin, y));
          ok = true;
          break;
        }
        if (yMin - yMax < bestGap) {
          bestGap = yMin - yMax;
          bestQ = q;
          best.set(hull);
        }
      }
      if (!ok) {
        // 最も収まりのよい向きで、壁の点を除いて地表より上に置く
        q = bestQ;
        hull.set(best);
        const [yMinAll] = range(x, z, hull, Infinity);
        const [yMin, yMax] = range(x, z, hull, wallLimit);
        if (yMinAll > yMin + 1e-6) stats.wallContacts++;
        if (yMin > yMax) {
          y = yMin;
          stats.overTop++;
          stats.maxOverTop = Math.max(stats.maxOverTop, yMin - yMax);
        } else {
          y = Math.min(yMax, Math.max(yMin, y));
        }
      }
      // 地表より下の代表点の確認（壁の点を除く）
      for (let p = 0; p < H; p++) {
        const kk = cellIndex(s, x + (hull[p * 3] as number), z + (hull[p * 3 + 2] as number));
        if (kk < 0) continue;
        const g = s.ground[kk] as number;
        if (Number.isNaN(g) || g > wallLimit) continue;
        const below = g - (y + (hull[p * 3 + 1] as number));
        if (below > stats.maxBelowGround) stats.maxBelowGround = below;
      }
      centers[i * 3] = x;
      centers[i * 3 + 1] = y;
      centers[i * 3 + 2] = z;
      qRotate(q, cx0, cy0, cz0, rotated, 0);
      positions[i * 3] = x - (rotated[0] as number);
      positions[i * 3 + 1] = y - (rotated[1] as number);
      positions[i * 3 + 2] = z - (rotated[2] as number);
      quats.set(q, i * 4);
      const d = depthAt(s, x, y, z, grad);
      depths[i] = d;
      // 並べ替えの鍵（成長がなければ、表面からの鉛直の深さが深いほど先）
      const surfY = surfaceAt(s, x, z);
      keys[i] = Number.isNaN(surfY) ? 0 : -(surfY - y);
    }
  }

  // 5. 成長の順
  let arrivalsRaw: Float64Array;
  if (params.growth) {
    arrivalsRaw = arrivalFromGrowth(params.growth, ground, centers, placed);
    for (let m = 0; m < placed; m++) keys[m] = arrivalsRaw[m] as number;
  } else {
    arrivalsRaw = keys;
  }
  const order = new Uint32Array(placed);
  for (let m = 0; m < placed; m++) order[m] = m;
  order.sort((a, b) => (keys[a] as number) - (keys[b] as number) || a - b);

  const out = {
    positions: new Float32Array(placed * 3),
    quaternions: new Float32Array(placed * 4),
    centers: new Float32Array(placed * 3),
    depths: new Float32Array(placed),
    arrivals: new Float32Array(placed),
  };
  for (let m = 0; m < placed; m++) {
    const o = order[m] as number;
    out.positions.set(positions.subarray(o * 3, o * 3 + 3), m * 3);
    out.centers.set(centers.subarray(o * 3, o * 3 + 3), m * 3);
    out.quaternions.set(quats.subarray(o * 4, o * 4 + 4), m * 4);
    out.depths[m] = depths[o] as number;
    out.arrivals[m] = params.growth ? (arrivalsRaw[o] as number) : placed > 1 ? m / (placed - 1) : 0;
  }
  stats.ms = performance.now() - t0;
  return {
    mode,
    representedCount: N,
    count: placed,
    ...out,
    volume,
    effectiveUnitVolume: N > 0 ? volume / N : 0,
    volumeMismatch: N > 0 && unitVolume > 0 ? volume / (N * unitVolume) - 1 : 0,
    stats,
  };
}

/**
 * 成長の段階の厚さから、各中心が堆積に覆われる進捗 t を求める。
 * セルの厚さは段階の間で t について線形（`thicknessAt` と同じ）なので、区間を探して線形に解く。
 */
function arrivalFromGrowth(growth: PileGrowth, ground: HeightGrid, centers: Float32Array, count: number): Float64Array {
  const { col0, row0, col1, row1 } = growth.bounds;
  const bw = col1 - col0 + 1;
  const bh = row1 - row0 + 1;
  const out = new Float64Array(count).fill(1);
  if (bw <= 0 || bh <= 0) return out;
  const F = growth.fractions;
  const K = F.length;
  // 段階ごとの厚さ（外接矩形の範囲だけ）
  const layers = new Float32Array(K * bw * bh);
  const full = new Float32Array(ground.width * ground.height);
  for (let k = 0; k < K; k++) {
    growth.thicknessAt(F[k] as number, full);
    for (let r = 0; r < bh; r++) {
      const src = (row0 + r) * ground.width + col0;
      layers.set(full.subarray(src, src + bw), k * bw * bh + r * bw);
    }
  }
  const cs = ground.cellSize;
  for (let i = 0; i < count; i++) {
    const c = Math.floor(((centers[i * 3] as number) - ground.originX) / cs) - col0;
    const r = Math.floor(((centers[i * 3 + 2] as number) - ground.originZ) / cs) - row0;
    if (c < 0 || r < 0 || c >= bw || r >= bh) continue;
    const g = ground.data[(r + row0) * ground.width + c + col0] as number;
    const hgt = (centers[i * 3 + 1] as number) - g;
    const j = r * bw + c;
    let prevT = 0;
    let prevF = 0;
    for (let k = 0; k < K; k++) {
      const t = layers[k * bw * bh + j] as number;
      const f = F[k] as number;
      if (t >= hgt) {
        out[i] = t > prevT && k > 0 ? prevF + ((hgt - prevT) / (t - prevT)) * (f - prevF) : f;
        break;
      }
      prevT = t;
      prevF = f;
    }
  }
  return out;
}
