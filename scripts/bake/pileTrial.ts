/**
 * 焼き込んだ格子で堆積計算を試す（`npm run data:grids:pile`）。
 * GRID_PILE_TRIALS の地点の近くの開けた地表（findOpenGround）に積み、頂上・面積・端・警告を表示する。
 */
import { GRID_PILE_ANGLE, GRID_PILE_TRIALS } from '../../src/data/grids';
import { latLonToLocal } from '../../src/geo/enu';
import { findOpenGround } from '../../src/sim/heightGrid';
import { depositPiles } from '../../src/sim/pile';
import { readCityGrid } from './readGrid';

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
      warnings: r.warnings,
      ms: Math.round(ms),
    }),
  );
}
