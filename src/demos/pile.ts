/**
 * 確認ページ: 合成街区に山を積む。
 * URL パラメータ:
 * - `volume` 総体積(m³)。既定 60000。
 * - `angle` 安息角(度)。既定 35。
 * - `t` 成長の進捗（0〜1）。指定すると成長の途中の形を表示する。
 */
import { createBuildingsMesh, createPileMesh } from '../scene/pileMesh';
import { createScene } from '../scene/createScene';
import { computePileGrowth, depositPiles, type PileResult, type PileSource } from '../sim/pile';
import { createSyntheticCity } from '../sim/syntheticCity';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・手動確認用の結果。 */
    __PILE__?: {
      volume: number;
      totalVolume: number;
      /** 厚さの合計 × セルの面積から求めた体積(m³)。 */
      thicknessVolume: number;
      apexY: number[];
      reachedEdge: boolean;
      warnings: number;
      ms: number;
    };
  }
}

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};
const volume = Math.max(0, num('volume', 60000));
const angle = Math.min(60, Math.max(10, num('angle', 35)));
const tParam = params.has('t') ? Math.min(1, Math.max(0, num('t', 1))) : null;

const city = createSyntheticCity({ size: 400, seed: 2, minHeight: 3, maxHeight: 45 });
// 駅前の交差点（原点）を中心に3か所へ投入する。
const sources: PileSource[] = [
  { x: 0, z: 0, volume: volume * 0.6 },
  { x: 48, z: 3, volume: volume * 0.25 },
  { x: -4, z: -48, volume: volume * 0.15 },
];

const t0 = performance.now();
let thickness: Float32Array;
let extent: Float32Array;
let result: PileResult;
if (tParam === null) {
  result = depositPiles(city.grid, sources, angle);
  thickness = result.thickness;
  extent = thickness;
} else {
  const growth = computePileGrowth(city.grid, sources, angle);
  result = growth.final;
  extent = result.thickness;
  thickness = growth.thicknessAt(tParam);
}
const ms = performance.now() - t0;
let thicknessSum = 0;
// totalVolume と照合するため、最終状態の厚さで求める。
for (let i = 0; i < result.thickness.length; i++) thicknessSum += result.thickness[i] as number;
const thicknessVolume = thicknessSum * city.grid.cellSize * city.grid.cellSize;
window.__PILE__ = {
  volume,
  totalVolume: result.totalVolume,
  thicknessVolume,
  apexY: result.piles.map((p) => p.apexY),
  reachedEdge: result.reachedEdge,
  warnings: result.warnings.length,
  ms,
};

const container = document.getElementById('app');
if (!container) throw new Error('#app が見つかりません');
const ctx = createScene(container, { referenceBox: false });
ctx.scene.add(createBuildingsMesh(city.buildings));
const pile = createPileMesh(city.grid, extent);
if (thickness !== extent) pile.update(thickness);
ctx.scene.add(pile.mesh);

ctx.camera.position.set(95, 165, 150);
ctx.controls.target.set(5, 0, -8);
ctx.controls.update();

const info = document.getElementById('info');
if (info) {
  const apex = Math.max(0, ...result.piles.map((p) => (Number.isFinite(p.apexY) ? p.apexY : 0)));
  info.textContent =
    `体積 ${Math.round(volume).toLocaleString()} m³ / 積んだ体積 ${Math.round(result.totalVolume).toLocaleString()} m³` +
    `（厚さの合計 ${Math.round(thicknessVolume).toLocaleString()} m³）` +
    ` / 頂上 ${apex.toFixed(1)} m / 安息角 ${angle}°` +
    (tParam === null ? '' : ` / 進捗 t=${tParam}`) +
    ` / 計算 ${ms.toFixed(0)} ms` +
    (result.reachedEdge ? ' / ⚠ 格子の端に達しています（山が切れています）' : '') +
    (result.warnings.length > 0 ? ` / 警告 ${result.warnings.map((w) => `${w.kind}#${w.source}`).join(', ')}` : '');
}

ctx.renderer.setAnimationLoop(ctx.render);
ctx.render();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
