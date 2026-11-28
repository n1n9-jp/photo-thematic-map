import {
  BoxGeometry,
  Color,
  Fog,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GROUND_SIZE_M, REFERENCE_BOX_SIZE_M } from '../config';
import { PALETTE } from './palette';
import { createPaletteLights } from './paletteLights';

/**
 * 深度バッファの方式。
 * - standard: 通常の深度バッファ。
 * - reversed: 逆深度（`EXT_clip_control` が要る）。使えない環境では logarithmic にする。
 * - logarithmic: 対数深度（フラグメントで深度を書き換える）。
 */
export type DepthMode = 'standard' | 'reversed' | 'logarithmic';

/** 実際に使われた深度の方式。 */
export type ResolvedDepthMode = DepthMode;

export interface SceneContext<C extends OrbitControls | null = OrbitControls> {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** `controls: false` で作ったときは null。 */
  controls: C;
  /** 実際に使われた深度の方式。 */
  depthMode: ResolvedDepthMode;
  /** 1フレーム描画する。 */
  render(): void;
  /**
   * 描画サイズを決め直す。サイズが変わったら true（呼び出し側は描画し直す）。
   * ResizeObserver から自動で呼ばれるので、通常は呼ばなくてよい。
   */
  resize(): boolean;
  /** 描画サイズが変わったときに呼ばれる（描画の要求に使う）。戻り値で登録解除。 */
  onResize(listener: () => void): () => void;
  dispose(): void;
}

export interface AltitudeFogOptions {
  /** カメラの高さ 0 のときの霧の始まり(m)。既定 1500。 */
  near?: number;
  /** カメラの高さ 0 のときの霧の終わり(m)。既定 6000。 */
  far?: number;
  /** カメラの高さ 1m ごとに霧の始まりを遠ざける量(m)。既定 1.5。 */
  nearPerHeight?: number;
  /** カメラの高さ 1m ごとに霧の終わりを遠ざける量(m)。既定 5。 */
  farPerHeight?: number;
  /** カメラの高さを測る基準のローカル Y（地表の目安）。既定 0。 */
  groundY?: number;
}

export interface CreateSceneOptions {
  /** 原点に基準箱を置くか（既定 true）。`minimal: false` なら置かない。 */
  referenceBox?: boolean;
  /** 最小シーン用の地面（1km 四方）と基準箱を作るか（既定 true）。本編では false。 */
  minimal?: boolean;
  /** OrbitControls を作るか（既定 true）。false なら `controls` は null。 */
  controls?: boolean;
  /** 深度バッファの方式（既定 standard）。reversed が使えない環境では logarithmic になる。 */
  depth?: DepthMode;
  /** 背景（空）の色。既定は配色（`palette.ts`）の空の色。霧の色も同じにする。 */
  skyColor?: number;
  /**
   * 霧をカメラの高さに合わせて変える（俯瞰で街が霞みすぎない）。`render()` のたびに更新する。
   * 既定 false（固定の霧 800〜3000m）。
   */
  altitudeFog?: boolean | AltitudeFogOptions;
  /**
   * タッチ端末で「幅が同じで高さだけが少し（25% 未満）変わる」リサイズ（アドレスバーの出入り）では、
   * 描画バッファを作り直さない（canvas は CSS でコンテナいっぱいに伸ばす）。既定 false。
   */
  stableViewport?: boolean;
  /** devicePixelRatio の上限。既定 2。 */
  maxPixelRatio?: number;
  /** カメラの初期の near / far。既定 1 / 20000（語りのカメラリグを使うなら毎フレーム上書きされる）。 */
  near?: number;
  far?: number;
  /** カメラの縦の画角(度)。既定 50。 */
  fov?: number;
}

/** 幅が変わらず高さだけが変わる、この割合未満のリサイズはアドレスバーの出入りとみなす。 */
const MINOR_HEIGHT_CHANGE = 0.25;

function isTouchDevice(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.maxTouchPoints > 0 &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** reversed を選んだとき実際に使えるか（`EXT_clip_control`）。 */
function supportsClipControl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ok = !!gl?.getExtension('EXT_clip_control');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/** 最小シーン（空・光・地面・基準箱・OrbitControls）を構築する。オプションで本編用の土台にもなる。 */
export function createScene(container: HTMLElement, options: CreateSceneOptions & { controls: false }): SceneContext<null>;
export function createScene(container: HTMLElement, options?: CreateSceneOptions): SceneContext;
export function createScene(container: HTMLElement, options: CreateSceneOptions = {}): SceneContext<OrbitControls | null> {
  const requested = options.depth ?? 'standard';
  let depthMode: ResolvedDepthMode = requested;
  if (requested === 'reversed' && !supportsClipControl()) depthMode = 'logarithmic';

  const renderer = new WebGLRenderer({
    antialias: true,
    reversedDepthBuffer: depthMode === 'reversed',
    logarithmicDepthBuffer: depthMode === 'logarithmic',
  });
  const maxPixelRatio = options.maxPixelRatio ?? 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const sky = options.skyColor ?? PALETTE.sky;
  const scene = new Scene();
  scene.background = new Color(sky);
  const fog = new Fog(sky, 800, 3000);
  scene.fog = fog;
  const altitudeFog: AltitudeFogOptions | null =
    options.altitudeFog === true ? {} : options.altitudeFog ? options.altitudeFog : null;

  const size0 = containerSize();
  const camera = new PerspectiveCamera(options.fov ?? 50, size0.w / size0.h, options.near ?? 1, options.far ?? 20000);
  camera.position.set(40, 30, 50);

  const lights = createPaletteLights(PALETTE.lights);
  scene.add(lights.hemisphere, lights.ambient);
  const sun = lights.sun;
  sun.position.set(-200, 400, 150);
  scene.add(sun);

  const minimal = options.minimal ?? true;
  const disposables: { dispose(): void }[] = [];
  if (minimal) {
    const groundGeometry = new PlaneGeometry(GROUND_SIZE_M, GROUND_SIZE_M);
    const groundMaterial = new MeshStandardMaterial({ color: 0x7c8a6a, roughness: 1 });
    const ground = new Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    disposables.push(groundGeometry, groundMaterial);

    if (options.referenceBox ?? true) {
      const boxGeometry = new BoxGeometry(REFERENCE_BOX_SIZE_M, REFERENCE_BOX_SIZE_M, REFERENCE_BOX_SIZE_M);
      const boxMaterial = new MeshStandardMaterial({ color: 0xe0533d, roughness: 0.6 });
      const box = new Mesh(boxGeometry, boxMaterial);
      box.position.y = REFERENCE_BOX_SIZE_M / 2;
      scene.add(box);
      disposables.push(boxGeometry, boxMaterial);
    }
  }

  let controls: OrbitControls | null = null;
  if (options.controls ?? true) {
    controls = new OrbitControls(camera, canvas);
    controls.target.set(0, REFERENCE_BOX_SIZE_M / 2, 0);
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.update();
  }

  /** コンテナの大きさ(CSS px)。まだレイアウトされていなければ window の大きさ。 */
  function containerSize(): { w: number; h: number } {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0) return { w, h };
    return { w: Math.max(window.innerWidth, 1), h: Math.max(window.innerHeight, 1) };
  }

  const stable = options.stableViewport ?? false;
  let bufferW = 0;
  let bufferH = 0;
  const listeners = new Set<() => void>();

  function resize(): boolean {
    const { w, h } = containerSize();
    const pr = Math.min(window.devicePixelRatio, maxPixelRatio);
    const prChanged = renderer.getPixelRatio() !== pr;
    if (!prChanged && w === bufferW && h === bufferH) return false;
    if (
      stable &&
      !prChanged &&
      bufferW > 0 &&
      w === bufferW &&
      Math.abs(h - bufferH) < bufferH * MINOR_HEIGHT_CHANGE &&
      isTouchDevice()
    ) {
      // アドレスバーの出入り。描画バッファはそのまま、canvas を CSS で伸ばす。
      return false;
    }
    bufferW = w;
    bufferH = h;
    if (prChanged) renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const l of [...listeners]) l();
    // setSize は描画バッファを消すので、すでに描画していたらすぐに描き直す（ResizeObserver は描画の直前に呼ばれる）。
    if (renderedOnce) render();
    return true;
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  observer?.observe(container);
  // 画面の回転や devicePixelRatio の変化はコンテナの大きさが変わらないこともあるので window でも見る。
  const onWindowResize = (): void => {
    resize();
  };
  window.addEventListener('resize', onWindowResize);

  function updateFog(): void {
    if (!altitudeFog) return;
    const h = Math.max(camera.position.y - (altitudeFog.groundY ?? 0), 0);
    fog.near = (altitudeFog.near ?? 1500) + h * (altitudeFog.nearPerHeight ?? 1.5);
    fog.far = (altitudeFog.far ?? 6000) + h * (altitudeFog.farPerHeight ?? 5);
  }

  let renderedOnce = false;
  function render(): void {
    controls?.update();
    updateFog();
    renderer.render(scene, camera);
    renderedOnce = true;
  }
  resize();

  const dispose = (): void => {
    observer?.disconnect();
    window.removeEventListener('resize', onWindowResize);
    listeners.clear();
    controls?.dispose();
    for (const d of disposables) d.dispose();
    renderer.dispose();
    canvas.remove();
  };

  return {
    renderer,
    scene,
    camera,
    controls,
    depthMode,
    render,
    resize,
    onResize(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose,
  };
}
