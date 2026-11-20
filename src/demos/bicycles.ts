/**
 * 確認ページ: ママチャリの形状と大量描画。
 *
 * URL パラメータ
 * - count: 総台数（既定 30000）。駐輪の列と1台の見本を除いた残りを山積みに使う。
 * - view: 初期カメラ（closeup | parked | heap | heapdetail | overview、既定 heap）。
 * - seed: 乱数の種（既定 1）。
 * - buried: far | hidden。山の内部（表面から 1m より深い）を遠景用で描くか、描かないか（既定 far）。
 * - lod: 0 | 1 | 2。確認用に全台の詳細度を固定する（setInstances の前に設定）。
 * - bench: 1 なら計測モード。描画を一定時間回して window.__BENCH__ に結果を入れる。
 */
import {
  AmbientLight,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Color,
  Fog,
  WebGLRenderer,
  type Vector3Tuple,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BicycleField, type BicycleFieldStats } from '../scene/bicycle/field';
import { concatInstances, heapOnSurface, moundHeight, parkedRows, singleBicycle } from '../scene/bicycle/layouts';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    __BENCH__?: BenchResult;
    __BICYCLE_STATS__?: BicycleFieldStats;
  }
}

interface BenchResult {
  count: number;
  view: string;
  setupMs: number;
  frames: number;
  seconds: number;
  fps: number;
  triangles: number;
  drawCalls: number;
  perLod: [number, number, number];
}

const params = new URLSearchParams(location.search);
const totalCount = Math.max(1, Math.floor(Number(params.get('count') ?? 30000)) || 30000);
const seed = Math.floor(Number(params.get('seed') ?? 1)) || 1;
const viewName = params.get('view') ?? 'heap';
const bench = params.get('bench') === '1';
const buried = params.get('buried') === 'hidden' ? 'hidden' : 'far';

// 配置
const HEAP_CENTER = { x: 0, z: -45 };
const HEAP_RADIUS = 30;
const HEAP_PEAK = 20;
const SHOWCASE = { x: 30, y: 0, z: 8 };
const PARKED_PER_ROW = 70;
const parkedCount = Math.min(totalCount - 1, PARKED_PER_ROW * 2);
const heapCount = Math.max(0, totalCount - 1 - parkedCount);

const VIEWS: Record<string, { pos: Vector3Tuple; target: Vector3Tuple }> = {
  closeup: { pos: [SHOWCASE.x + 1.25, 1.15, SHOWCASE.z + 2.35], target: [SHOWCASE.x, 0.52, SHOWCASE.z] },
  parked: { pos: [-24, 2.3, 9.5], target: [-8, 0.5, 3.0] },
  heap: { pos: [34, 17, -6], target: [0, 6, -45] },
  heapdetail: { pos: [14, 6, -20], target: [4, 3, -30] },
  overview: { pos: [55, 28, 45], target: [0, 7, -42] },
};
const view = VIEWS[viewName] ?? VIEWS.heap!;

const container = document.getElementById('app')!;
const hud = document.getElementById('hud')!;

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const SKY = 0xb9d3ea;
const scene = new Scene();
scene.background = new Color(SKY);
scene.fog = new Fog(SKY, 250, 900);

const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 3000);
camera.position.set(...view.pos);

scene.add(new HemisphereLight(0xe6f0ff, 0x5d574d, 1.1));
scene.add(new AmbientLight(0xffffff, 0.35));
const sun = new DirectionalLight(0xfff4e2, 2.2);
sun.position.set(-120, 200, 90);
scene.add(sun);

// 地面（アスファルト）と歩道
const ground = new Mesh(new PlaneGeometry(1200, 1200), new MeshLambertMaterial({ color: 0x5f6164 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const sidewalk = new Mesh(new PlaneGeometry(110, 9), new MeshLambertMaterial({ color: 0x9d988d }));
sidewalk.rotation.x = -Math.PI / 2;
sidewalk.position.set(0, 0.01, 3.5);
scene.add(sidewalk);

// 身長 1.7m の人型の目安（柱＋頭）
const personMat = new MeshLambertMaterial({ color: 0xe8a33a });
function addPerson(x: number, z: number): void {
  const body = new Mesh(new CylinderGeometry(0.17, 0.2, 1.45, 12), personMat);
  body.position.set(x, 0.725, z);
  const head = new Mesh(new SphereGeometry(0.12, 12, 8), personMat);
  head.position.set(x, 1.58, z);
  scene.add(body, head);
}
addPerson(SHOWCASE.x - 1.5, SHOWCASE.z - 0.9);
addPerson(-8, 5.6);
addPerson(HEAP_CENTER.x + 18, HEAP_CENTER.z + HEAP_RADIUS + 2);

// 自転車
const t0 = performance.now();
const field = new BicycleField();
const forcedLod = params.get('lod');
if (forcedLod === '0' || forcedLod === '1' || forcedLod === '2') field.forceLod = Number(forcedLod) as 0 | 1 | 2;
const instances = concatInstances(
  singleBicycle(SHOWCASE, 0.25, 0x1d2a52),
  parkedRows({ seed, count: parkedCount, start: { x: -40, z: 4.2 }, perRow: PARKED_PER_ROW, spacing: 0.62, rowGap: 3.4 }),
  heapOnSurface({
    seed: seed + 1,
    count: heapCount,
    height: moundHeight(HEAP_CENTER, HEAP_RADIUS, HEAP_PEAK),
    bounds: {
      minX: HEAP_CENTER.x - HEAP_RADIUS,
      maxX: HEAP_CENTER.x + HEAP_RADIUS,
      minZ: HEAP_CENTER.z - HEAP_RADIUS,
      maxZ: HEAP_CENTER.z + HEAP_RADIUS,
    },
    buried,
  }),
);
field.setInstances(instances);
scene.add(field.object);
const setupMs = performance.now() - t0;

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...view.target);
controls.maxPolarAngle = Math.PI / 2 - 0.01;
controls.update();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// フレームレート（直近1秒の平均）
let fps = 0;
let frameCountWindow = 0;
let windowStart = performance.now();

const fmt = (n: number): string => n.toLocaleString('en-US');
function updateHud(): void {
  const s = field.stats;
  hud.textContent =
    `台数      ${fmt(s.total)}\n` +
    `描画三角形 ${fmt(renderer.info.render.triangles)}\n` +
    `FPS       ${fps.toFixed(1)}\n` +
    `LOD 近/中/遠 ${fmt(s.perLod[0])} / ${fmt(s.perLod[1])} / ${fmt(s.perLod[2])}`;
}

function renderFrame(): void {
  controls.update();
  field.update(camera, renderer.domElement.height / renderer.getPixelRatio());
  renderer.render(scene, camera);
  window.__BICYCLE_STATS__ = field.stats;
  frameCountWindow++;
  const now = performance.now();
  if (now - windowStart >= 1000) {
    fps = (frameCountWindow * 1000) / (now - windowStart);
    frameCountWindow = 0;
    windowStart = now;
  }
  updateHud();
}

renderFrame();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});

if (bench) {
  // 計測: 描画を GPU 完了まで待ちながら一定時間回す
  const gl = renderer.getContext();
  const durationMs = Number(params.get('benchMs') ?? 4000);
  let frames = 0;
  let begin = 0;
  const step = (): void => {
    renderFrame();
    gl.finish();
    if (frames === 0) begin = performance.now();
    frames++;
    const elapsed = performance.now() - begin;
    if (elapsed < durationMs || frames < 4) {
      requestAnimationFrame(step);
    } else {
      window.__BENCH__ = {
        count: totalCount,
        view: viewName,
        setupMs,
        frames: frames - 1,
        seconds: elapsed / 1000,
        fps: (frames - 1) / (elapsed / 1000),
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        perLod: [...field.stats.perLod],
      };
    }
  };
  requestAnimationFrame(step);
} else {
  renderer.setAnimationLoop(renderFrame);
}
