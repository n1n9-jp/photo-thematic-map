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
  /** 行優先の高さ(m)。長さは width * height。 */
  data: Float32Array;
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
