/**
 * 確認ページ: 秋葉原駅の周りの放置自転車 462台の配置（本編の場面1・2・8 と同じ配置）。
 *
 * URL パラメータ
 * - view: top（真上からの全体図。駅から 500m の円つき）| street（場面1 のカメラ = 路上の目線）| scene2（場面2 のカメラ）|
 *   close（駅前を真上の近くから）| plan（街の高さ格子の範囲 700m 四方を真上の遠くから。建物を描かず航空写真だけ。
 *   線路の位置を格子と照らし合わせる用。画面を正方形にして使う）。既定 top。
 * - shown: 表示する台数（既定 462）。置いた順なので「shown 台のときの配置」になる。
 * - marker: 足元の印の半径(m)（既定 top は 2.5、street と plan は 0（描かない）、ほかは本編と同じ 1.3）。
 * - cam: 方位,高さ,水平距離,注視点の東,注視点の北（m、駅の位置から）で視点を差し替える（カメラの位置を探す確認用）。
 */
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineLoop, type Vector3Tuple } from 'three';
import { latLonToLocal, localToLatLon } from '../geo/enu';
import { computeAkihabaraInWorker } from '../app/modules/akihabara/computeInWorker';
import { AKIHABARA_RADIUS_M, AKIHABARA_STATION } from '../app/modules/akihabara/layout';
import { BikeMarkers } from '../app/modules/akihabara/markers';
import { BicycleField } from '../scene/bicycle/field';
import { stationLayoutToInstances } from '../scene/bicycle/stationInstances';
import { createPlateauStage } from '../scene/plateau/stage';
import { keyframeToPose, poseToCameraPosition } from '../story/cameraPath';
import { SCRIPT } from '../story/content/script';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・手動確認用の結果。 */
    __AKIHABARA_DEMO__?: {
      view: string;
      placed: number;
      shown: number;
      onGround: number;
      underBridge: number;
      maxDistanceM: number;
      maxFromStartM: number;
      prepareMs: number;
      layoutMs: number;
      /** 自転車の Y と、街並みの地面（国土地理院の標高タイル）の差(m)の最大（絶対値）と平均。 */
      groundDiffMax: number;
      groundDiffMean: number;
      first: { lat: number; lon: number; y: number; yawDeg: number };
      perLod: [number, number, number];
    };
  }
}

const params = new URLSearchParams(location.search);
const viewName = ['top', 'street', 'scene2', 'close', 'plan'].includes(params.get('view') ?? '') ? params.get('view')! : 'top';
const infoEl = document.getElementById('info')!;
const container = document.getElementById('app')!;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

const resultPromise = computeAkihabaraInWorker();
const stagePromise = createPlateauStage({ container, center: AKIHABARA_STATION, radiusM: 1500 });
const [res, stage] = await Promise.all([resultPromise, stagePromise]);
const { layout } = res;
const shownParam = Number(params.get('shown'));
const shown = params.has('shown') && Number.isFinite(shownParam) ? Math.max(0, Math.min(layout.count, Math.floor(shownParam))) : layout.count;

// 自転車と足元の印
const field = new BicycleField();
field.addGroup(stationLayoutToInstances(layout, { seed: 3 }), { reveal: shown });
stage.scene.add(field.object);
const markerParam = Number(params.get('marker'));
const markerRadius =
  params.has('marker') && Number.isFinite(markerParam) ? markerParam : viewName === 'top' ? 2.5 : viewName === 'plan' || viewName === 'street' ? 0 : 1.3;
if (viewName === 'plan') field.object.visible = params.get('bikes') === '1';
let markers: BikeMarkers | null = null;
if (markerRadius > 0) {
  markers = new BikeMarkers(layout.positions, layout.count, { radius: markerRadius });
  markers.setShown(shown, false);
  stage.scene.add(markers.mesh);
}

// 駅から 500m の円
const st = latLonToLocal(AKIHABARA_STATION);
const stationY = await stage.ground.elevation.elevationAt(AKIHABARA_STATION.lat, AKIHABARA_STATION.lon);
{
  const pts: number[] = [];
  for (let k = 0; k < 128; k++) {
    const a = (k / 128) * Math.PI * 2;
    pts.push(st.x + Math.cos(a) * AKIHABARA_RADIUS_M, stationY + 0.5, st.z + Math.sin(a) * AKIHABARA_RADIUS_M);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
  stage.scene.add(new LineLoop(geo, new LineBasicMaterial({ color: 0xffd34d })));
}

// 自転車の Y と街並みの地面の差
let diffMax = 0;
let diffSum = 0;
for (let i = 0; i < layout.count; i++) {
  const x = layout.positions[i * 3]!;
  const z = layout.positions[i * 3 + 2]!;
  const ll = localToLatLon({ x, y: 0, z });
  const e = await stage.ground.elevation.elevationAt(ll.lat, ll.lon);
  const d = Math.abs(layout.positions[i * 3 + 1]! - e);
  diffMax = Math.max(diffMax, d);
  diffSum += d;
}

// 視点
const sceneGround = await Promise.all(SCRIPT.map((s) => stage.ground.elevation.elevationAt(s.camera.target.lat, s.camera.target.lon)));
function sceneCamera(index: number): { pos: Vector3Tuple; target: Vector3Tuple } {
  const kf = SCRIPT[index]!.camera;
  const pose = keyframeToPose(kf, () => sceneGround[index]!);
  const p = poseToCameraPosition(pose);
  return { pos: [p.x, p.y, p.z], target: [pose.target.x, pose.target.y, pose.target.z] };
}
const VIEWS: Record<string, () => { pos: Vector3Tuple; target: Vector3Tuple; fov?: number }> = {
  top: () => ({ pos: [st.x, stationY + 1250, st.z + 1], target: [st.x, stationY, st.z], fov: 45 }),
  // 高さ 7500m（建物を描かない高さ）から、格子の 700m 四方がちょうど画面の高さに入る画角
  plan: () => ({ pos: [624, 7500, -1908 + 0.01], target: [624, 0, -1908], fov: (2 * Math.atan(350 / 7500) * 180) / Math.PI }),
  close: () => ({ pos: [st.x - 90, stationY + 300, st.z + 1], target: [st.x - 90, stationY, st.z], fov: 45 }),
  street: () => sceneCamera(0),
  scene2: () => sceneCamera(1),
};
const view = VIEWS[viewName]!();
// 確認用: cam=方位,高さ,水平距離,注視点の東,注視点の北（m、駅の位置から）で視点を差し替える
const camParam = params.get('cam')?.split(',').map(Number);
if (camParam && camParam.length === 5 && camParam.every(Number.isFinite)) {
  const [az, h, hz, east, north] = camParam as [number, number, number, number, number];
  const tx = st.x + east;
  const tz = st.z - north;
  const a = (az * Math.PI) / 180;
  view.target = [tx, stationY, tz];
  view.pos = [tx - Math.sin(a) * hz, stationY + h, tz + Math.cos(a) * hz];
}
stage.camera.fov = view.fov ?? 45;
stage.camera.position.set(...view.pos);
stage.controls.target.set(...view.target);
stage.controls.minDistance = 1;
stage.controls.update();

const first = localToLatLon({ x: layout.positions[0]!, y: 0, z: layout.positions[2]! });
function frame(): void {
  field.update(stage.camera, stage.renderer.domElement.height / stage.renderer.getPixelRatio());
  markers?.update(0.016);
  stage.render();
  window.__AKIHABARA_DEMO__ = {
    view: viewName,
    placed: layout.count,
    shown,
    onGround: res.onGround,
    underBridge: res.underBridge,
    maxDistanceM: res.maxDistanceM,
    maxFromStartM: res.maxFromStartM,
    prepareMs: res.prepareMs,
    layoutMs: res.layoutMs,
    groundDiffMax: diffMax,
    groundDiffMean: diffSum / Math.max(layout.count, 1),
    first: { lat: first.lat, lon: first.lon, y: layout.positions[1]!, yawDeg: (layout.yaws[0]! * 180) / Math.PI },
    perLod: [...field.stats.perLod],
  };
  infoEl.textContent =
    `秋葉原駅の周り ${fmt(layout.count)}台（表示 ${fmt(shown)}）/ ${viewName}\n` +
    `地面 ${fmt(res.onGround)}台・高架の下 ${fmt(res.underBridge)}台\n` +
    `駅から最も遠い自転車 ${res.maxDistanceM.toFixed(0)} m（置き始めの点から ${res.maxFromStartM.toFixed(0)} m）\n` +
    `地面との差 最大 ${diffMax.toFixed(2)} m・平均 ${(diffSum / Math.max(layout.count, 1)).toFixed(2)} m\n` +
    `計算 ms 格子の読込 ${fmt(res.loadMs)} / 路上の判定 ${fmt(res.prepareMs)} / 配置 ${fmt(res.layoutMs)}`;
}
stage.renderer.setAnimationLoop(frame);
if (viewName === 'plan') {
  // 建物を描かない高さなので、建物の読み込みは待たず、地面（航空写真）だけを待つ
  await new Promise<void>((resolve) => {
    let quiet = 0;
    const timer = setInterval(() => {
      quiet = stage.ground.isLoading ? 0 : quiet + 1;
      if (quiet >= 10) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });
} else await stage.ready;
frame();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
