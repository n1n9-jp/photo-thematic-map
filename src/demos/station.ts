/**
 * 確認ページ: 駅の周りの路上に放置自転車を1台ずつ配置する。
 *
 * 合成した街区の中央付近の街区を駅舎にし（駅の位置は駅舎の屋上）、その周りの路上に置く。
 *
 * URL パラメータ
 * - count: 台数（既定 462 = 秋葉原駅）。
 * - shown: 先頭の何台を表示するか（既定 全台）。置いた順なので「shown 台のときの配置」になる。
 * - view: overview（斜め上から全体）| near（真上に近い近景）| street（路上の目線）。既定 overview。
 * - seed: 乱数の種（既定 1）。
 */
import { BoxGeometry, DataTexture, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, RingGeometry, SRGBColorSpace, NearestFilter, type Vector3Tuple } from 'three';
import { createScene } from '../scene/createScene';
import { createBuildingsMesh } from '../scene/pileMesh';
import { BicycleField } from '../scene/bicycle/field';
import { stationLayoutToInstances } from '../scene/bicycle/stationInstances';
import { layoutStation, prepareStreetMap } from '../sim/stationLayout';
import { createSyntheticCity, type BoxBuilding } from '../sim/syntheticCity';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・手動確認用の結果。 */
    __STATION__?: { count: number; shown: number; placed: number; prepareMs: number; layoutMs: number; maxDistance: number };
  }
}

const params = new URLSearchParams(location.search);
const intParam = (key: string, fallback: number): number => {
  const v = Math.floor(Number(params.get(key)));
  return params.has(key) && Number.isFinite(v) && v >= 0 ? v : fallback;
};
const count = intParam('count', 462);
const shown = Math.min(count, intParam('shown', count));
const seed = intParam('seed', 1) || 1;
const viewName = params.get('view') ?? 'overview';

// 街区: 合成した格子状の街。原点の南東の街区全体を駅舎にする。
const city = createSyntheticCity({ size: 1040, seed: 3, minHeight: 4, maxHeight: 45 });
const grid = city.grid;
const STATION_BLOCK: BoxBuilding = { x0: 7, z0: 7, x1: 41, z1: 41, top: 16 };
type Rect = { x0: number; z0: number; x1: number; z1: number };
const overlaps = (b: Rect, r: Rect): boolean =>
  b.x0 < r.x1 && b.x1 > r.x0 && b.z0 < r.z1 && b.z1 > r.z0;
const buildings = city.buildings.filter((b) => !overlaps(b, STATION_BLOCK));
buildings.push(STATION_BLOCK);
const fillRect = (r: Rect, h: number): void => {
  const cs = grid.cellSize;
  for (let row = 0; row < grid.height; row++) {
    const z = grid.originZ + (row + 0.5) * cs;
    if (z < r.z0 || z > r.z1) continue;
    for (let col = 0; col < grid.width; col++) {
      const x = grid.originX + (col + 0.5) * cs;
      if (x >= r.x0 && x <= r.x1) grid.data[row * grid.width + col] = h;
    }
  }
};
fillRect(STATION_BLOCK, STATION_BLOCK.top);
const STATION = { x: 24, z: 24 }; // 駅舎の屋上の中央

const t0 = performance.now();
const streetMap = prepareStreetMap(grid);
const t1 = performance.now();
const layout = layoutStation(streetMap, STATION, count, seed);
const t2 = performance.now();
let maxDistance = 0;
for (let i = 0; i < count; i++) {
  maxDistance = Math.max(maxDistance, Math.hypot(layout.positions[i * 3]! - STATION.x, layout.positions[i * 3 + 2]! - STATION.z));
}
window.__STATION__ = { count, shown, placed: layout.count, prepareMs: t1 - t0, layoutMs: t2 - t1, maxDistance };

// シーン
const container = document.getElementById('app')!;
const ctx = createScene(container, { referenceBox: false });
const { scene, camera, controls, renderer } = ctx;
camera.near = 0.3;
camera.far = 5000;
// createScene の地面は路上の地面と重なるので外す
for (const obj of [...scene.children]) {
  if (obj instanceof Mesh && obj.geometry instanceof PlaneGeometry) scene.remove(obj);
}

// 地面: 路上を舗装の色、それ以外（建物の足元）を暗く塗った格子のテクスチャ
const tex = new Uint8Array(grid.width * grid.height * 4);
for (let i = 0; i < grid.width * grid.height; i++) {
  const st = streetMap.street[i] === 1;
  const v = st ? 104 : 60;
  tex[i * 4] = v;
  tex[i * 4 + 1] = v;
  tex[i * 4 + 2] = v + (st ? 4 : 0);
  tex[i * 4 + 3] = 255;
}
const groundTex = new DataTexture(tex, grid.width, grid.height);
groundTex.colorSpace = SRGBColorSpace;
groundTex.magFilter = NearestFilter;
groundTex.flipY = false;
groundTex.needsUpdate = true;
const gw = grid.width * grid.cellSize;
const gh = grid.height * grid.cellSize;
const groundGeo = new PlaneGeometry(gw, gh);
// 平面の UV(0,0) を格子の北西の角（行 0）に合わせる
groundGeo.rotateX(-Math.PI / 2);
const uv = groundGeo.getAttribute('uv');
for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
const ground = new Mesh(groundGeo, new MeshLambertMaterial({ map: groundTex }));
ground.position.set(grid.originX + gw / 2, 0.01, grid.originZ + gh / 2);
scene.add(ground);

scene.add(createBuildingsMesh(buildings));
// 駅舎の目印（屋上の赤い板）と、駅から 500m の円
const mark = new Mesh(new BoxGeometry(STATION_BLOCK.x1 - STATION_BLOCK.x0, 0.4, STATION_BLOCK.z1 - STATION_BLOCK.z0), new MeshLambertMaterial({ color: 0xc8413a }));
mark.position.set((STATION_BLOCK.x0 + STATION_BLOCK.x1) / 2, STATION_BLOCK.top + 0.2, (STATION_BLOCK.z0 + STATION_BLOCK.z1) / 2);
scene.add(mark);
const ring = new Mesh(new RingGeometry(498, 502, 128), new MeshBasicMaterial({ color: 0xffd34d }));
ring.rotation.x = -Math.PI / 2;
ring.position.set(STATION.x, 0.05, STATION.z);
scene.add(ring);

// 自転車
const field = new BicycleField();
field.setInstances(stationLayoutToInstances(layout, { seed, count: shown }));
scene.add(field.object);

const VIEWS: Record<string, { pos: Vector3Tuple; target: Vector3Tuple; fov: number }> = {
  overview: { pos: [STATION.x + 80, 165, STATION.z + 120], target: [STATION.x + 2, 0, STATION.z + 14], fov: 30 },
  near: { pos: [STATION.x + 4, 110, STATION.z + 22], target: [STATION.x, 0, STATION.z], fov: 50 },
  street: { pos: [50.5, 1.6, 47], target: [43, 0.9, 30], fov: 55 },
};
const view = VIEWS[viewName] ?? VIEWS.overview!;
camera.fov = view.fov;
camera.updateProjectionMatrix();
camera.position.set(...view.pos);
controls.target.set(...view.target);
controls.update();

const hud = document.getElementById('hud')!;
const fmt = (n: number): string => n.toLocaleString('en-US');
hud.textContent =
  `台数     ${fmt(count)}（表示 ${fmt(shown)}）\n` +
  `最遠     ${maxDistance.toFixed(0)} m\n` +
  `路上判定 ${(t1 - t0).toFixed(0)} ms / 配置 ${(t2 - t1).toFixed(0)} ms`;

function frame(): void {
  controls.update();
  field.update(camera, renderer.domElement.height / renderer.getPixelRatio());
  renderer.render(scene, camera);
}
frame();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
renderer.setAnimationLoop(frame);
