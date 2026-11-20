/**
 * 確認ページ: ママチャリの形状と大量描画。
 *
 * URL パラメータ
 * - count: 総台数（既定 6000）。駐輪の列と1台の見本を除いた残りを山積みに使う。
 * - view: 初期カメラ（closeup | parked | heap | heapdetail | overview、既定 heap）。
 * - seed: 乱数の種（既定 1）。
 * - buried: far | hidden。山の内部（表面から 1m より深い）を遠景用で描くか、描かないか（既定 far）。
 * - lod: 0 | 1 | 2。確認用に全台の詳細度を固定する。
 * - far: 1 なら、すべてを原点から西へ 60km（地表は接平面から約 283m 下）に置く。遠い位置での描画精度の確認用。
 * - reveal: 0〜1。駐輪の列と山積みで、登録順の先頭からこの割合の台数だけを表示する（setRevealCount）。
 * - bench: 1 なら計測モード。描画を一定時間回して window.__BENCH__ に結果を入れる。
 * - bench: reveal なら、表示台数の切り替えとカメラ移動の転送量を計測して window.__BENCH__ に入れる。
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
  Group,
  WebGLRenderer,
  type Vector3Tuple,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BicycleField, type BicycleFieldStats, type BicycleInstances } from '../scene/bicycle/field';
import { heapOnSurface, moundHeight, parkedRows, singleBicycle } from '../scene/bicycle/layouts';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    __BENCH__?: BenchResult | RevealBenchResult;
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

interface RevealBenchResult {
  count: number;
  /** setRevealCount 1回あたりの所要時間(ms)。 */
  setRevealMs: number;
  /** setRevealCount の後の update の所要時間(ms)。 */
  updateAfterRevealMs: number;
  /** カメラを動かしたときの1フレームあたりの転送バイト数。 */
  moveUploadBytes: { frames: number; mean: number; max: number; rebuilds: number };
  /** 静止したカメラでの1フレームあたりの転送バイト数の最大。 */
  staticUploadMax: number;
  initialUploadBytes: number;
  setupMs: number;
}

const params = new URLSearchParams(location.search);
const totalCount = Math.max(1, Math.floor(Number(params.get('count') ?? 6000)) || 6000);
const seed = Math.floor(Number(params.get('seed') ?? 1)) || 1;
const viewName = params.get('view') ?? 'heap';
const bench = params.get('bench') === '1';
const revealBench = params.get('bench') === 'reveal';
const buried = params.get('buried') === 'hidden' ? 'hidden' : 'far';
const far = params.get('far') === '1';
const revealParam = params.get('reveal');
const revealFraction = revealParam === null ? 1 : Math.min(1, Math.max(0, Number(revealParam) || 0));
/** 全体を置く位置。far=1 のときは原点から西へ 60km（接平面なので地表は約 283m 下がる）。 */
const OFFSET = far ? { x: -60_000, y: -282.5, z: 0 } : { x: 0, y: 0, z: 0 };

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
const baseView = VIEWS[viewName] ?? VIEWS.heap!;
const shift = (p: Vector3Tuple): Vector3Tuple => [p[0] + OFFSET.x, p[1] + OFFSET.y, p[2] + OFFSET.z];
const view = { pos: shift(baseView.pos), target: shift(baseView.target) };

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
// 背景の物体（地面・人型）もまとめて OFFSET に置く
const world = new Group();
world.position.set(OFFSET.x, OFFSET.y, OFFSET.z);
scene.add(world);
camera.position.set(...view.pos);

scene.add(new HemisphereLight(0xe6f0ff, 0x5d574d, 1.1));
scene.add(new AmbientLight(0xffffff, 0.35));
const sun = new DirectionalLight(0xfff4e2, 2.2);
sun.position.set(-120, 200, 90);
scene.add(sun);

// 地面（アスファルト）と歩道
const ground = new Mesh(new PlaneGeometry(1200, 1200), new MeshLambertMaterial({ color: 0x5f6164 }));
ground.rotation.x = -Math.PI / 2;
world.add(ground);
const sidewalk = new Mesh(new PlaneGeometry(110, 9), new MeshLambertMaterial({ color: 0x9d988d }));
sidewalk.rotation.x = -Math.PI / 2;
sidewalk.position.set(0, 0.01, 3.5);
world.add(sidewalk);

// 身長 1.7m の人型の目安（柱＋頭）
const personMat = new MeshLambertMaterial({ color: 0xe8a33a });
function addPerson(x: number, z: number): void {
  const body = new Mesh(new CylinderGeometry(0.17, 0.2, 1.45, 12), personMat);
  body.position.set(x, 0.725, z);
  const head = new Mesh(new SphereGeometry(0.12, 12, 8), personMat);
  head.position.set(x, 1.58, z);
  world.add(body, head);
}
addPerson(SHOWCASE.x - 1.5, SHOWCASE.z - 0.9);
addPerson(-8, 5.6);
addPerson(HEAP_CENTER.x + 18, HEAP_CENTER.z + HEAP_RADIUS + 2);

// 自転車（まとまりごとに登録する。位置は OFFSET からの相対値で渡す）
const t0 = performance.now();
const field = new BicycleField();
const forcedLod = params.get('lod');
if (forcedLod === '0' || forcedLod === '1' || forcedLod === '2') field.forceLod = Number(forcedLod) as 0 | 1 | 2;
const withOrigin = (inst: BicycleInstances): BicycleInstances => ({ ...inst, origin: OFFSET });
field.addGroup(withOrigin(singleBicycle(SHOWCASE, 0.25, 0x1d2a52)));
const parked = withOrigin(
  parkedRows({ seed, count: parkedCount, start: { x: -40, z: 4.2 }, perRow: PARKED_PER_ROW, spacing: 0.62, rowGap: 3.4 }),
);
const parkedGroup = field.addGroup(parked);
const heap = withOrigin(
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
const heapGroup = field.addGroup(heap);
field.setRevealCount(Math.round(parked.count * revealFraction), parkedGroup);
field.setRevealCount(Math.round(heap.count * revealFraction), heapGroup);
scene.add(field.object);
// 構築は最初の update で行うので、ここで1回呼んで計測に含める
field.update(camera, window.innerHeight);
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
    `台数      ${fmt(s.total)}（表示 ${fmt(s.revealed)}）\n` +
    `描画三角形 ${fmt(renderer.info.render.triangles)}\n` +
    `FPS       ${fps.toFixed(1)}\n` +
    `LOD 近/中/遠 ${fmt(s.perLod[0])} / ${fmt(s.perLod[1])} / ${fmt(s.perLod[2])}\n` +
    `転送      ${fmt(s.frameUploadBytes)} B/frame\n` +
    (far ? `位置      原点から西へ ${fmt(-OFFSET.x)} m\n` : '');
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

if (revealBench) {
  // 計測: 表示台数の切り替えの所要時間と、カメラを動かしたときの転送量（描画はしない）
  const initialUploadBytes = field.stats.uploadBytes;
  const h = renderer.domElement.height / renderer.getPixelRatio();
  const staticUploads: number[] = [];
  for (let i = 0; i < 30; i++) {
    field.update(camera, h);
    staticUploads.push(field.stats.frameUploadBytes);
  }
  let setMs = 0;
  let updMs = 0;
  const steps = 200;
  for (let i = 1; i <= steps; i++) {
    const a = performance.now();
    field.setRevealCount(Math.round((heap.count * i) / steps), heapGroup);
    const b = performance.now();
    field.update(camera, h);
    const c = performance.now();
    setMs += b - a;
    updMs += c - b;
  }
  // 山の周りを1フレーム 0.2° ずつ回り込む（300フレーム）
  const center = controls.target.clone();
  const rel = camera.position.clone().sub(center);
  const uploads: number[] = [];
  const rebuilds0 = field.stats.rebuilds;
  for (let i = 1; i <= 300; i++) {
    const ang = (i * 0.2 * Math.PI) / 180;
    camera.position.set(
      center.x + rel.x * Math.cos(ang) - rel.z * Math.sin(ang),
      center.y + rel.y,
      center.z + rel.x * Math.sin(ang) + rel.z * Math.cos(ang),
    );
    camera.lookAt(center);
    field.update(camera, h);
    uploads.push(field.stats.frameUploadBytes);
  }
  window.__BENCH__ = {
    count: field.stats.total,
    setRevealMs: setMs / steps,
    updateAfterRevealMs: updMs / steps,
    moveUploadBytes: {
      frames: uploads.length,
      mean: uploads.reduce((x, y) => x + y, 0) / uploads.length,
      max: Math.max(...uploads),
      rebuilds: field.stats.rebuilds - rebuilds0,
    },
    staticUploadMax: Math.max(...staticUploads),
    initialUploadBytes,
    setupMs,
  };
} else if (bench) {
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
