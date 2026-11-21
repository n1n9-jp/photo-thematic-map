/**
 * 本編の山の場面（場面5・6）の数値を、本編と同じ計算（computePileScene）で求める。
 * `node --experimental-transform-types --no-warnings=ExperimentalWarning --import ./scripts/bake/register.ts scripts/bake/pileFacts.ts`
 * 結果（投入点・頂上・覆う面積・裾の直径）を facts.ts の PILES に写す。
 */
import { DataUtils } from 'three';
import { PILE_SITES } from '../../src/app/modules/pileSites';
import { localToLatLon, latLonToLocal } from '../../src/geo/enu';
import { computePileScene, type PileComputeResult } from '../../src/scene/pileScene/compute';
import type { HeightGrid } from '../../src/sim/heightGrid';
import { readCityGrid } from './readGrid';

/** 計算結果から、山が覆う範囲（最終の厚さ 5cm 以上）の面積・同じ面積の円の直径・外接矩形・投入点からの最大距離。 */
export function pileFootprint(r: PileComputeResult): { areaM2: number; diameterM: number; bboxM: [number, number]; maxRadiusM: number } {
  const K = r.fractions.length;
  const lw = r.layerWidth;
  const lh = r.layerHeight;
  const last = r.layers.subarray((K - 1) * lw * lh);
  const cs = r.layerRect.cellSize;
  let cells = 0;
  let maxR = 0;
  let bx0 = Infinity;
  let bx1 = -Infinity;
  let bz0 = Infinity;
  let bz1 = -Infinity;
  for (let i = 0; i < lw * lh; i++) {
    if (!(DataUtils.fromHalfFloat(last[i]!) > 0.05)) continue;
    cells++;
    const x = r.layerRect.x0 + ((i % lw) + 0.5) * cs;
    const z = r.layerRect.z0 + (Math.floor(i / lw) + 0.5) * cs;
    maxR = Math.max(maxR, Math.hypot(x - r.site.x, z - r.site.z));
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x);
    bz0 = Math.min(bz0, z);
    bz1 = Math.max(bz1, z);
  }
  const areaM2 = cells * cs * cs;
  return { areaM2, diameterM: 2 * Math.sqrt(areaM2 / Math.PI), bboxM: [bx1 - bx0 + cs, bz1 - bz0 + cs], maxRadiusM: maxR };
}

/** 本編の山の地点で計算する。 */
export function computeSitePile(site: (typeof PILE_SITES)[keyof typeof PILE_SITES], surface?: HeightGrid): PileComputeResult {
  const g = surface ?? readCityGrid(site.grid).surface;
  const p = latLonToLocal({ lat: site.lat, lon: site.lon });
  return computePileScene(g, { x: p.x, z: p.z, count: site.count, mode: site.mode });
}

const CASES = Object.values(PILE_SITES);
if (process.argv[1]?.endsWith('pileFacts.ts')) {
  for (const c of CASES) {
    const r = computeSitePile(c);
    const fp = pileFootprint(r);
    const ll = localToLatLon({ x: r.site.x, y: 0, z: r.site.z });
    console.log(
      JSON.stringify({
        key: c.key,
        site: { lat: Number(ll.lat.toFixed(6)), lon: Number(ll.lon.toFixed(6)), x: r.site.x, z: r.site.z, groundY: r.site.groundY, shiftedBy: r.site.shiftedBy },
        apexY: Number(r.apexY.toFixed(2)),
        apexHeight: Number(r.apexHeight.toFixed(2)),
        volume: Math.round(r.volume),
        areaM2: Math.round(fp.areaM2),
        diameterM: Number(fp.diameterM.toFixed(1)),
        bboxM: fp.bboxM.map((v) => Math.round(v)),
        maxRadiusM: Math.round(fp.maxRadiusM),
        placed: r.placedCount,
        ms: Math.round(r.timings.totalMs),
      }),
    );
  }
}
