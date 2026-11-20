/**
 * 確認ページ: 東京全体を俯瞰して、駅ごとの放置自転車の台数を立体の印（柱 / 山）で見せる。
 *
 * 単色の地面の上に、位置の手がかりとして東京駅・新宿駅・渋谷駅・池袋駅・上野駅の目印と名前を置く。
 *
 * URL パラメータ
 * - view: wards（23区全体が入る俯瞰）| tokyo（都全体が入る俯瞰）。既定 wards。
 * - shape: column（柱）| cone（山）。既定 column。
 */
import { CircleGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, RingGeometry, Vector3 } from 'three';
import { loadStationSites, totalBicycles, type StationSite } from '../data/stations';
import { latLonToLocal } from '../geo/enu';
import { createScene } from '../scene/createScene';
import { StationMarkers, type MarkerShape, type Rect } from '../scene/stationMarkers';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・手動確認用の結果。 */
    __STATIONS_OVERVIEW__?: {
      view: string;
      shape: MarkerShape;
      sites: number;
      total: number;
      cameraHeight: number;
      setVisibility(v: number): void;
    };
  }
}

type ViewName = 'wards' | 'tokyo';

const params = new URLSearchParams(location.search);
const viewName: ViewName = params.get('view') === 'tokyo' ? 'tokyo' : 'wards';
const shape: MarkerShape = params.get('shape') === 'cone' ? 'cone' : 'column';

/** 位置の手がかり（緯度経度は stations.json の国土数値情報 N02 に基づく駅の位置）。 */
const LANDMARKS = [
  { name: '東京', lat: 35.680984, lon: 139.76662 },
  { name: '新宿', lat: 35.689796, lon: 139.69993 },
  { name: '渋谷', lat: 35.658977, lon: 139.701647 },
  { name: '池袋', lat: 35.730046, lon: 139.710597 },
  { name: '上野', lat: 35.713049, lon: 139.776655 },
] as const;

/** 俯瞰のカメラを、地面からどれだけ傾けて見下ろすか（鉛直からの角度）。 */
const TILT_DEG = 24;

const sites = await loadStationSites();

// 単色の地面は平らなので、印の底も高さ 0 に置く（既定の groundY は接平面の落ち込みを含む）。
const markers = new StationMarkers(sites, { shape, groundY: () => 0 });

const container = document.getElementById('app')!;
const ctx = createScene(container, { referenceBox: false });
const { scene, camera, controls, renderer } = ctx;
scene.fog = null;
for (const obj of [...scene.children]) {
  if (obj instanceof Mesh && obj.geometry instanceof PlaneGeometry) scene.remove(obj);
}
const ground = new Mesh(new PlaneGeometry(800_000, 800_000), new MeshBasicMaterial({ color: 0x55646b }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1;
scene.add(ground);

scene.add(markers.object);
markers.mountOverlay(container);

// 位置の手がかり: 白い輪と名前
const ring = new RingGeometry(170, 300, 40).rotateX(-Math.PI / 2);
const dot = new CircleGeometry(120, 24).rotateX(-Math.PI / 2);
const ringMat = new MeshBasicMaterial({ color: 0xffffff });
const landmarkLabels = document.createElement('div');
landmarkLabels.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
container.appendChild(landmarkLabels);
const landmarks = LANDMARKS.map((l) => {
  const p = latLonToLocal({ lat: l.lat, lon: l.lon, alt: 0 });
  for (const geo of [ring, dot]) {
    const mesh = new Mesh(geo, ringMat);
    mesh.position.set(p.x, 6, p.z);
    scene.add(mesh);
  }
  const el = document.createElement('div');
  el.textContent = l.name;
  el.style.cssText =
    'position:absolute;left:0;top:0;padding:0 3px;font:600 12px/1.3 "Hiragino Sans","Noto Sans JP","Yu Gothic","WenQuanYi Zen Hei",sans-serif;' +
    'color:#fff;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000,0 0 2px #000';
  landmarkLabels.appendChild(el);
  return { pos: new Vector3(p.x, 6, p.z), el };
});

// 俯瞰の範囲: 23区は「区」の付く区市町村の駅、都全体はすべての駅
const extentSites: StationSite[] = viewName === 'wards' ? sites.filter((s) => s.municipality.endsWith('区')) : [...sites];
const extent = (() => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of extentSites) {
    const p = latLonToLocal({ lat: s.lat, lon: s.lon, alt: 0 });
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
})();

/** 範囲の四隅が画面（NDC の ±limit）に収まる最小の距離で、カメラを置く。 */
function fitCamera(cam: PerspectiveCamera, limit: number): number {
  const target = new Vector3((extent.minX + extent.maxX) / 2, 0, (extent.minZ + extent.maxZ) / 2);
  const tilt = (TILT_DEG * Math.PI) / 180;
  // カメラは対象の南側から北を向く（+Z が南）
  const dir = new Vector3(0, Math.cos(tilt), Math.sin(tilt));
  const corners = [
    new Vector3(extent.minX, 0, extent.minZ),
    new Vector3(extent.maxX, 0, extent.minZ),
    new Vector3(extent.minX, 0, extent.maxZ),
    new Vector3(extent.maxX, 0, extent.maxZ),
  ];
  const fits = (d: number): boolean => {
    cam.position.copy(target).addScaledVector(dir, d);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    return corners.every((c) => {
      const v = c.clone().project(cam);
      return Math.abs(v.x) <= limit && Math.abs(v.y) <= limit;
    });
  };
  let lo = 2_000;
  let hi = 600_000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  fits(hi);
  controls.target.copy(target);
  controls.update();
  return hi;
}

let cameraDistance = 0;
function applyView(): void {
  camera.fov = 55;
  camera.near = 200;
  camera.far = 900_000;
  camera.updateProjectionMatrix();
  // 凡例とラベルの余地として、画面の端を少し空ける
  cameraDistance = fitCamera(camera, 0.9);
}
applyView();
window.addEventListener('resize', applyView);

const containerSize = (): { w: number; h: number } => ({ w: container.clientWidth, h: container.clientHeight });
const tmp = new Vector3();

function frame(): void {
  controls.update();
  const { w, h } = containerSize();
  camera.updateMatrixWorld();
  const obstacles: Rect[] = [];
  for (const l of landmarks) {
    tmp.copy(l.pos).project(camera);
    const x = ((tmp.x + 1) / 2) * w;
    const y = ((1 - tmp.y) / 2) * h;
    l.el.style.transform = `translate(${x + 8}px,${y - 8}px)`;
    obstacles.push({ x: x - 6, y: y - 8, w: l.el.offsetWidth + 16, h: 17 });
  }
  markers.update(camera, obstacles);
  renderer.render(scene, camera);
}

window.__STATIONS_OVERVIEW__ = {
  view: viewName,
  shape,
  sites: sites.length,
  total: totalBicycles(sites),
  cameraHeight: cameraDistance * Math.cos((TILT_DEG * Math.PI) / 180),
  setVisibility: (v) => markers.setVisibility(v),
};

frame();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
renderer.setAnimationLoop(frame);
