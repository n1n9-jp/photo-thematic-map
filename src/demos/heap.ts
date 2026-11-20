/**
 * 確認ページ: 合成街区の交差点に、台数ぶんの体積の山を積み、自転車を詰める。
 *
 * URL パラメータ
 * - count: 山が表す台数（既定 187262）。体積は 台数 × 0.35m³。
 * - reveal: 0〜1。成長の順に先頭のこの割合だけを表示する（既定 1）。山の表面もその段階の形にする。
 * - surface: 1 なら表層（表面から 1.5m）だけを置く。
 * - view: overview | base | close（既定 overview）。
 * - seed: 乱数の種（既定 1）。
 * - buried: hidden | far。表面から 1m より深い自転車を描かないか、遠景用で描くか（既定 hidden）。
 */
import type { Vector3Tuple } from 'three';
import { BicycleField, type BicycleFieldStats } from '../scene/bicycle/field';
import { heapFillToInstances } from '../scene/bicycle/layouts';
import { createScene } from '../scene/createScene';
import { createBuildingsMesh, createPileMesh } from '../scene/pileMesh';
import { fillHeap, surfaceDepths } from '../sim/heapFill';
import { computePileGrowth, type PileSource } from '../sim/pile';
import { createSyntheticCity } from '../sim/syntheticCity';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・手動確認用の結果。 */
    __HEAP__?: {
      represented: number;
      placed: number;
      shown: number;
      drawn: number;
      volume: number;
      fillMs: number;
      pileMs: number;
      overTop: number;
      maxBelowGround: number;
      wallContacts: number;
      apexY: number;
      stats: BicycleFieldStats;
    };
  }
}

const UNIT_VOLUME = 0.35;
const ANGLE = 35;
/** 山の表面のメッシュを下げる量(m)。表面の自転車の隙間から奥の陰として見せる。 */
const SURFACE_SINK = 0.8;

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};
const count = Math.max(1, Math.floor(num('count', 187262)));
const reveal = Math.min(1, Math.max(0, num('reveal', 1)));
const surfaceOnly = params.get('surface') === '1';
const viewName = params.get('view') ?? 'overview';
const seed = Math.floor(num('seed', 1));
const buried = params.get('buried') === 'far' ? 'far' : 'hidden';

// 街と山
const city = createSyntheticCity({ size: 400, seed: 2, minHeight: 3, maxHeight: 45 });
const grid = city.grid;
const sources: PileSource[] = [{ x: 0, z: 0, volume: count * UNIT_VOLUME }];
const t0 = performance.now();
const growth = computePileGrowth(grid, sources, ANGLE);
const pileMs = performance.now() - t0;
const final = growth.final;
const fill = fillHeap({
  ground: grid,
  thickness: final.thickness,
  count,
  unitVolume: UNIT_VOLUME,
  seed,
  mode: surfaceOnly ? 'surface' : 'full',
  growth,
});

// 表示する範囲（成長の途中なら、その段階の山と先頭の台数）
const shownThickness = reveal < 1 ? growth.thicknessAt(reveal) : final.thickness;
let shown = fill.count;
let depths = fill.depths;
if (reveal < 1) {
  // 先頭から、進捗 reveal までに覆われる自転車
  shown = 0;
  while (shown < fill.count && (fill.arrivals[shown] as number) <= reveal) shown++;
  depths = surfaceDepths(grid, shownThickness, fill.centers, shown);
}
const instances = heapFillToInstances(fill, { seed, limit: shown, depths, buried, buriedDepth: 1.0 });

// 描画
const container = document.getElementById('app');
if (!container) throw new Error('#app が見つかりません');
const ctx = createScene(container, { referenceBox: false });
ctx.camera.near = 0.2;
ctx.camera.far = 5000;
ctx.camera.updateProjectionMatrix();
ctx.scene.add(createBuildingsMesh(city.buildings));
const pile = createPileMesh(grid, final.thickness, 0x3d3a36);
if (shownThickness !== final.thickness) pile.update(shownThickness);
pile.mesh.position.y = -SURFACE_SINK;
ctx.scene.add(pile.mesh);
const field = new BicycleField();
field.setInstances(instances);
ctx.scene.add(field.object);

// 視点（最終の山の大きさから決める）
const cs = grid.cellSize;
let maxR = 0;
let edgeX = 0;
for (let k = 0; k < final.thickness.length; k++) {
  if (!((final.thickness[k] as number) > 0)) continue;
  const r = (k / grid.width) | 0;
  const c = k - r * grid.width;
  const x = grid.originX + (c + 0.5) * cs;
  const z = grid.originZ + (r + 0.5) * cs;
  maxR = Math.max(maxR, Math.hypot(x, z));
  if (Math.abs(z) < cs && x > edgeX) edgeX = x; // 東へ延びる道路の中心線上の裾
}
const apexY = Math.max(0, ...final.piles.map((p) => (Number.isFinite(p.apexY) ? p.apexY : 0)));
const surfaceY = (x: number, z: number): number => {
  const c = Math.floor((x - grid.originX) / cs);
  const r = Math.floor((z - grid.originZ) / cs);
  const k = r * grid.width + c;
  return (grid.data[k] as number) + (final.thickness[k] as number);
};
const closeX = edgeX * 0.55;
const closeY = surfaceY(closeX, 0);
const VIEWS: Record<string, { pos: Vector3Tuple; target: Vector3Tuple }> = {
  // 建物の上から見下ろす（仰角 約65°。手前の建物に山が隠れにくい角度）
  overview: { pos: [maxR * 0.55, apexY + 40 + maxR * 2.2, maxR * 0.95], target: [0, apexY * 0.25, 0] },
  base: { pos: [edgeX + 9, 1.7, 3.5], target: [edgeX - 6, 1.6, -0.5] },
  close: { pos: [closeX + 6, closeY + 3.5, 4], target: [closeX - 1, closeY - 0.5, 0] },
};
const view = VIEWS[viewName] ?? VIEWS.overview!;
ctx.camera.position.set(...view.pos);
ctx.controls.target.set(...view.target);
ctx.controls.update();

const info = document.getElementById('info');
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
function updateInfo(): void {
  if (!info) return;
  const s = field.stats;
  info.textContent =
    `表す台数   ${fmt(fill.representedCount)}\n` +
    `配置した台数 ${fmt(fill.count)}${surfaceOnly ? '（表層 1.5m）' : ''}\n` +
    `表示する台数 ${fmt(shown)}${reveal < 1 ? `（進捗 ${reveal}）` : ''}\n` +
    `描画した台数 ${fmt(s.visible)}（近/中/遠 ${fmt(s.perLod[0])} / ${fmt(s.perLod[1])} / ${fmt(s.perLod[2])}）\n` +
    `体積 ${fmt(fill.volume)} m³ / 頂上 ${apexY.toFixed(1)} m\n` +
    `計算 山 ${fmt(pileMs)} ms / 詰める ${fmt(fill.stats.ms)} ms`;
}

function frame(): void {
  ctx.controls.update();
  field.update(ctx.camera, ctx.renderer.domElement.height / ctx.renderer.getPixelRatio());
  ctx.renderer.render(ctx.scene, ctx.camera);
  updateInfo();
  window.__HEAP__ = {
    represented: fill.representedCount,
    placed: fill.count,
    shown,
    drawn: field.stats.visible,
    volume: fill.volume,
    fillMs: fill.stats.ms,
    pileMs,
    overTop: fill.stats.overTop,
    maxBelowGround: fill.stats.maxBelowGround,
    wallContacts: fill.stats.wallContacts,
    apexY,
    stats: { ...field.stats, perLod: [...field.stats.perLod] },
  };
}

frame();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
ctx.renderer.setAnimationLoop(frame);
