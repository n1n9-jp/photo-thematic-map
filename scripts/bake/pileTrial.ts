/**
 * 焼き込んだ格子で堆積計算を試す（`npm run data:grids:pile`）。
 * GRID_PILE_TRIALS の地点の近くの開けた地表（findOpenGround）に積み、頂上・面積・端・警告を表示する。
 */
import { GRID_PILE_ANGLE, GRID_PILE_TRIALS } from '../../src/data/grids';
import { latLonToLocal } from '../../src/geo/enu';
import { findOpenGround } from '../../src/sim/heightGrid';
import { depositPiles } from '../../src/sim/pile';
import { GRID_CLASS, type CityGrid } from '../../src/data/grids';
import { readCityGrid } from './readGrid';

/** 都庁第一本庁舎（新宿の試しでの広がりの目安）。 */
const TOCHO = { lat: 35.6895, lon: 139.69175 };

/** 山の広がり: 分類ごとの面積、投入点からの最大距離、都庁第一本庁舎までの距離。 */
function spread(g: CityGrid, thickness: Float32Array, sx: number, sz: number): Record<string, unknown> {
  const { width: W, cellSize: cs, originX, originZ } = g.surface;
  const area: Record<string, number> = { ground: 0, building: 0, bridge: 0, nodata: 0 };
  const names = Object.fromEntries(Object.entries(GRID_CLASS).map(([k, v]) => [v, k])) as Record<number, string>;
  const t = latLonToLocal(TOCHO);
  let maxR = 0;
  let minToTocho = Infinity;
  let bx0 = Infinity;
  let bx1 = -Infinity;
  let bz0 = Infinity;
  let bz1 = -Infinity;
  let onRoofMaxThickness = 0;
  for (let i = 0; i < thickness.length; i++) {
    const th = thickness[i] as number;
    if (!(th > 0)) continue;
    const k = names[g.classes[i] as number] ?? 'nodata';
    area[k] = (area[k] ?? 0) + cs * cs;
    if (k === 'building' || k === 'bridge') onRoofMaxThickness = Math.max(onRoofMaxThickness, th);
    const x = originX + ((i % W) + 0.5) * cs;
    const z = originZ + (Math.floor(i / W) + 0.5) * cs;
    maxR = Math.max(maxR, Math.hypot(x - sx, z - sz));
    minToTocho = Math.min(minToTocho, Math.hypot(x - t.x, z - t.z));
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x);
    bz0 = Math.min(bz0, z);
    bz1 = Math.max(bz1, z);
  }
  return {
    areaByClass: area,
    onRoofMaxThickness: Number(onRoofMaxThickness.toFixed(2)),
    maxRadius: Math.round(maxR),
    bbox: [bx0, bz0, bx1, bz1].map(Math.round),
    nearestToToChoCenter: Math.round(minToTocho),
    tochoLocal: [Math.round(t.x), Math.round(t.z)],
  };
}

for (const [name, trial] of Object.entries(GRID_PILE_TRIALS)) {
  if (!trial) continue;
  const g = readCityGrid(name);
  const p = latLonToLocal({ lat: trial.lat, lon: trial.lon });
  const open = findOpenGround(g.surface, p.x, p.z, { radiusCells: 6, threshold: 1.5 });
  if (!open) throw new Error(`${name}: 開けた地表が見つかりません`);
  const t0 = performance.now();
  const r = depositPiles(g.surface, [{ x: open.x, z: open.z, volume: trial.volume }], GRID_PILE_ANGLE);
  const ms = performance.now() - t0;
  const pile = r.piles[0];
  const cell = open.row * g.surface.width + open.col;
  console.log(
    JSON.stringify({
      name,
      label: trial.label,
      volume: trial.volume,
      source: { x: open.x, z: open.z, shiftedBy: Number(open.distance.toFixed(1)), groundY: Number((g.surface.data[cell] as number).toFixed(2)) },
      apexY: Number(pile?.apexY.toFixed(2)),
      apexHeight: Number(pile?.apexHeight.toFixed(2)),
      areaM2: Math.round(pile?.area ?? 0),
      totalVolume: Math.round(r.totalVolume),
      reachedEdge: r.reachedEdge,
      spread: spread(g, r.thickness, open.x, open.z),
      warnings: r.warnings,
      ms: Math.round(ms),
    }),
  );
}
