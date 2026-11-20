/**
 * 地表（建物の屋上を含む）の高さ格子。
 *
 * 座標の対応（CLAUDE.md の座標規約: X=東, Y=上, Z=南, 1単位=1m）:
 * - 列 `col`（0 … width-1）は +X（東）方向に並ぶ。
 * - 行 `row`（0 … height-1）は +Z（南）方向に並ぶ。行 0 が北端。
 * - `data[row * width + col]` がセル (col, row) の高さ（ローカル Y, m）。
 * - `(originX, originZ)` は格子の北西の角（X 最小・Z 最小の角）のローカル座標。
 *   セル (col, row) の中心は
 *   `x = originX + (col + 0.5) * cellSize`, `z = originZ + (row + 0.5) * cellSize`。
 */
export interface HeightGrid {
  /** 列数（東西方向のセル数）。 */
  width: number;
  /** 行数（南北方向のセル数）。 */
  height: number;
  /** セルの一辺(m)。 */
  cellSize: number;
  /** 格子の北西の角のローカル X(m)。 */
  originX: number;
  /** 格子の北西の角のローカル Z(m)。 */
  originZ: number;
  /**
   * 行優先の高さ(m)。長さは width * height。
   * 値のないセル（欠損）は NaN。堆積計算では欠損のセルは通れず、積もらない
   * （{@link fillMissingHeights} で近傍の値から埋められる）。
   */
  data: Float32Array;
}

/** 箱型の建物（ローカル座標, m）。x0<x1, z0<z1。 */
export interface BoxBuilding {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 屋上の高さ（ローカル Y, m）。 */
  top: number;
}

/** 空の（高さ 0 の）格子を作る。 */
export function createHeightGrid(
  width: number,
  height: number,
  cellSize: number,
  originX = -(width * cellSize) / 2,
  originZ = -(height * cellSize) / 2,
): HeightGrid {
  if (!(width > 0 && height > 0 && cellSize > 0)) throw new Error('格子の大きさが不正です');
  return { width, height, cellSize, originX, originZ, data: new Float32Array(width * height) };
}

/** セル (col, row) の中心のローカル座標 (x, z)。 */
export function cellCenter(grid: HeightGrid, col: number, row: number): { x: number; z: number } {
  return {
    x: grid.originX + (col + 0.5) * grid.cellSize,
    z: grid.originZ + (row + 0.5) * grid.cellSize,
  };
}

/** ローカル座標 (x, z) を含むセル。格子の外なら null。 */
export function cellAt(grid: HeightGrid, x: number, z: number): { col: number; row: number } | null {
  const col = Math.floor((x - grid.originX) / grid.cellSize);
  const row = Math.floor((z - grid.originZ) / grid.cellSize);
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return null;
  return { col, row };
}

/** 欠損（NaN）のセルの数。 */
export function countMissing(grid: HeightGrid): number {
  let n = 0;
  for (let i = 0; i < grid.data.length; i++) if (Number.isNaN(grid.data[i] as number)) n++;
  return n;
}

/**
 * 欠損（NaN）のセルを近傍の有効な値で埋めた新しい格子を返す（元の格子は変えない）。
 * 有効なセルから 8 近傍で 1 セルずつ広げ、各欠損セルには、先に埋まった隣接セルのうち
 * 最も低い値を入れる（建物の縁の欠損が屋上の高さで広がらないよう、低い側を採る）。
 * 有効な値が一つもなければ例外を投げる。
 */
export function fillMissingHeights(grid: HeightGrid): HeightGrid {
  const { width: w, height: h } = grid;
  const data = Float32Array.from(grid.data);
  const n = w * h;
  let frontier: number[] = [];
  let missing = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(data[i] as number)) missing++;
    else frontier.push(i);
  }
  if (missing === n) throw new Error('格子に有効な値がありません');
  const filledAt = new Uint8Array(n);
  while (missing > 0 && frontier.length > 0) {
    const next: number[] = [];
    const fresh: number[] = [];
    for (const c of frontier) {
      const row = (c / w) | 0;
      const col = c - row * w;
      for (let dr = -1; dr <= 1; dr++) {
        const r = row + dr;
        if (r < 0 || r >= h) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = col + dc;
          if (cc < 0 || cc >= w) continue;
          const k = r * w + cc;
          if (!Number.isNaN(data[k] as number) || filledAt[k]) continue;
          filledAt[k] = 1;
          fresh.push(k);
        }
      }
    }
    // この段で埋めるセルの値は、前の段までに値があった隣接セルの最小値。
    const values = fresh.map((k) => {
      const row = (k / w) | 0;
      const col = k - row * w;
      let m = Infinity;
      for (let dr = -1; dr <= 1; dr++) {
        const r = row + dr;
        if (r < 0 || r >= h) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = col + dc;
          if (cc < 0 || cc >= w) continue;
          const v = data[r * w + cc] as number;
          if (v < m) m = v;
        }
      }
      return m;
    });
    fresh.forEach((k, j) => {
      data[k] = values[j] as number;
      next.push(k);
    });
    missing -= fresh.length;
    frontier = next;
  }
  return { ...grid, data };
}

export interface OpenGroundOptions {
  /** 周囲とみなす半径（セル数, 既定 4）。 */
  radiusCells?: number;
  /** 周囲の最低の地表からの高さの許容(m)（既定 3）。これより高いセルは開けた地表ではない。 */
  threshold?: number;
}

/**
 * セル (col, row) の地表が、周囲（半径 radiusCells セルの円内）の最低の有効な地表より何 m 高いか。
 * 欠損のセルは NaN。
 * 半径より広い屋上の中央では 0 になる（屋上と判定できない）点に注意。
 */
export function localRelief(grid: HeightGrid, col: number, row: number, radiusCells = 4): number {
  const { width: w, height: h, data } = grid;
  const g0 = data[row * w + col] as number;
  if (Number.isNaN(g0)) return Number.NaN;
  const R = Math.max(0, Math.floor(radiusCells));
  let m = g0;
  for (let dr = -R; dr <= R; dr++) {
    const r = row + dr;
    if (r < 0 || r >= h) continue;
    for (let dc = -R; dc <= R; dc++) {
      const c = col + dc;
      if (c < 0 || c >= w || dc * dc + dr * dr > R * R) continue;
      const v = data[r * w + c] as number;
      if (v < m) m = v;
    }
  }
  return g0 - m;
}

/** 開けた地表のセル（欠損でなく、周囲の最低の地表から threshold 以内）か。 */
export function isOpenGround(grid: HeightGrid, col: number, row: number, options: OpenGroundOptions = {}): boolean {
  const rel = localRelief(grid, col, row, options.radiusCells ?? 4);
  return rel <= (options.threshold ?? 3);
}

/**
 * 位置 (x, z) から最も近い「開けた地表のセル」（{@link isOpenGround}）を探す。
 * 戻り値はそのセルの中心の座標と、(x, z) からの距離(m)。maxDistance(m) 以内になければ null。
 * (x, z) は格子の外でもよい。
 */
export function findOpenGround(
  grid: HeightGrid,
  x: number,
  z: number,
  options: OpenGroundOptions & { maxDistance?: number } = {},
): { x: number; z: number; col: number; row: number; distance: number } | null {
  const { width: w, height: h, cellSize: cs, originX, originZ } = grid;
  const u = (x - originX) / cs;
  const v = (z - originZ) / cs;
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const maxD = options.maxDistance ?? Infinity;
  // 格子のどのセルにも届く環の数の上限。
  const far = Math.max(Math.abs(c0), Math.abs(c0 - (w - 1)), Math.abs(r0), Math.abs(r0 - (h - 1)));
  const maxRing = Math.min(far, Number.isFinite(maxD) ? Math.ceil(maxD / cs) + 1 : far);
  let best: { col: number; row: number; d2: number } | null = null;
  for (let ring = 0; ring <= maxRing; ring++) {
    // 環 ring のセルは (u, v) から少なくとも (ring - 1) セル離れている。
    if (best && (ring - 1) * (ring - 1) > best.d2) break;
    for (let dr = -ring; dr <= ring; dr++) {
      const r = r0 + dr;
      if (r < 0 || r >= h) continue;
      const edgeRow = dr === -ring || dr === ring;
      for (let dc = -ring; dc <= ring; dc += edgeRow ? 1 : 2 * ring || 1) {
        const c = c0 + dc;
        if (c < 0 || c >= w) continue;
        const d2 = (c + 0.5 - u) ** 2 + (r + 0.5 - v) ** 2;
        if (best && d2 >= best.d2) continue;
        if (d2 * cs * cs > maxD * maxD) continue;
        if (isOpenGround(grid, c, r, options)) best = { col: c, row: r, d2 };
      }
    }
  }
  if (!best) return null;
  const center = cellCenter(grid, best.col, best.row);
  return { ...center, col: best.col, row: best.row, distance: Math.sqrt(best.d2) * cs };
}
