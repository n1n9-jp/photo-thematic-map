/**
 * 確認ページ: 街の上の地名（`scene/placeLabels.ts`）。台本の場面のカメラで PLATEAU の街並み（変換済みの建物と航空写真の地面）を見せ、
 * その場面の地名を重ねる。マウスでカメラを動かすと、カメラの高さに応じて出す地名の段階が変わる。
 *
 * URL パラメータ
 * - scene: 台本の場面 id（既定 akihabara-462）。場面の中でカメラが動く場面（場面2）は、場面の終わりのカメラ。
 */
import { createScene } from '../scene/createScene';
import { PlaceLabels, type ShownPlaceLabel } from '../scene/placeLabels';
import { addSiteAttribution } from '../scene/plateau/attribution';
import { PlateauCity } from '../scene/plateau/stage';
import { applyFit, clipPlanesFor, keyframeToPose, poseToCameraPosition, stopViewFor, viewFor } from '../story/cameraPath';
import { placesForScene } from '../story/content/placeNames';
import { PLACES, SCRIPT } from '../story/content/script';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・確認用。 */
    __PLACE_LABELS_DEMO__?: { scene: string; heightAboveGround(): number; shown(): readonly ShownPlaceLabel[] };
  }
}

const params = new URLSearchParams(location.search);
const scene = SCRIPT.find((s) => s.id === params.get('scene')) ?? SCRIPT.find((s) => s.id === 'akihabara-462')!;

const nav = document.getElementById('scenes')!;
for (const s of SCRIPT) {
  const a = document.createElement('a');
  a.href = `?scene=${s.id}`;
  a.textContent = s.id;
  if (s.id === scene.id) a.setAttribute('aria-current', 'page');
  nav.appendChild(a);
}

const container = document.getElementById('app')!;
const ctx = createScene(container, { minimal: false, controls: true, depth: 'logarithmic', skyColor: 0xbfd9ee, altitudeFog: true, fov: 45 });
const { camera, renderer, scene: three, controls } = ctx;
addSiteAttribution(document.body);

const focus = scene.place ?? { ...PLACES.wards, radiusM: 1500 };
const city = new PlateauCity({ scene: three, camera, renderer, buildings: 'baked', lookAt: () => controls.target, focus });

// 地名の地点とカメラの注視点の標高を先に読む（標高タイル）
const places = placesForScene(scene.id);
const heights = new Map<string, number>();
const key = (lat: number, lon: number): string => `${lat.toFixed(5)},${lon.toFixed(5)}`;
const portrait = window.innerHeight > window.innerWidth;
const view = scene.camera.stops?.length ? stopViewFor(scene.camera.stops[scene.camera.stops.length - 1]!, portrait) : viewFor(scene.camera, portrait);
await Promise.all(
  [...places, view.target].map(async (p) => heights.set(key(p.lat, p.lon), await city.ground.elevation.elevationAt(p.lat, p.lon))),
);
const groundHeight = (lat: number, lon: number): number => heights.get(key(lat, lon)) ?? 0;

const pose = applyFit(keyframeToPose(view, groundHeight), view.fit, {
  fovDeg: camera.fov,
  canvasHeight: window.innerHeight,
  regionWidth: window.innerWidth,
  regionHeight: window.innerHeight,
});
const cam = poseToCameraPosition(pose);
camera.position.set(cam.x, cam.y, cam.z);
controls.target.set(pose.target.x, pose.target.y, pose.target.z);
controls.update();

const labels = new PlaceLabels(container, { groundHeight });
labels.setPlaces(places);

/** カメラの真下の地表からの高さ(m)。地表は注視点の標高で近似する（確認ページなので）。 */
const heightAboveGround = (): number => camera.position.y - pose.target.y + (view.target.alt ?? 0);

const attributionRect = (): { x: number; y: number; w: number; h: number }[] => {
  const el = document.querySelector('.ptm-site-attribution');
  const navRect = nav.getBoundingClientRect();
  const out = [{ x: navRect.left, y: navRect.top, w: navRect.width, h: navRect.height }];
  if (el) {
    const r = el.getBoundingClientRect();
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
};

let frames = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  const h = Math.max(1, heightAboveGround());
  const clip = clipPlanesFor(camera.position.distanceTo(controls.target), h);
  if (camera.near !== clip.near || camera.far !== clip.far) {
    camera.near = clip.near;
    camera.far = clip.far;
    camera.updateProjectionMatrix();
  }
  city.update();
  ctx.render();
  labels.update(camera, {
    bounds: { x: 0, y: 0, w: container.clientWidth, h: container.clientHeight },
    obstacles: attributionRect(),
    heightAboveGround: h,
    target: controls.target,
  });
  if (++frames === 2) requestAnimationFrame(() => (window.__APP_READY__ = true));
});

window.__PLACE_LABELS_DEMO__ = { scene: scene.id, heightAboveGround, shown: () => labels.shown() };
