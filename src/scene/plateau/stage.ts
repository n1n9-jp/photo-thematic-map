/**
 * PLATEAU の街並み（建物 3D Tiles ＋ 航空写真の地面）を表示する舞台一式。
 *
 * - `PlateauCity`: 既存のシーンに足す街並み。`setFocus()` で「テクスチャ付きの建物を読む円」と「読み込む区」を
 *   差し替えられる（本編はカメラの注視点＝場面の場所に合わせて切り替える）。地面の半径と建物の表示は
 *   カメラの高さに合わせて変える（高さ 28km の俯瞰では建物を描かず、地面を23区全体に敷く）。
 * - `createPlateauStage`: renderer・カメラ・OrbitControls まで含めた単独の舞台（確認ページ demos/plateau 用）。
 */
import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { latLonToLocal } from '../../geo/enu';
import { addAttribution } from './attribution';
import { PlateauBuildings } from './buildings';
import { loadPlateauCatalog, selectTilesets } from './catalog';
import type { PlateauCatalog } from './catalog';
import { PlateauGround } from './ground';

/** 建物を読む場所。 */
export interface PlateauFocus {
  lat: number;
  lon: number;
  /** この半径(m)は LOD2 テクスチャ付きの建物を最も細かいタイルまで読む。既定 250。 */
  detailRadiusM?: number;
  /** その外側は LOD2 テクスチャなしの建物を視点からの距離に応じて読む。この半径(m)に掛かる区が対象。既定 1500。 */
  outerRadiusM?: number;
}

export interface PlateauCityOptions {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  catalog: PlateauCatalog;
  focus: PlateauFocus;
  /** 外側の建物の画面上の許容誤差(px)。大きいほど読む量が減る。既定 32。 */
  outerErrorTarget?: number;
  /** カメラの高さ（ローカル Y）がこれを超えると建物を描かず、読み込みもしない(m)。既定 7000。 */
  buildingsMaxHeightM?: number;
  /** 地面を敷く半径の最小値(m)。既定 6000。 */
  groundMinRadiusM?: number;
  /** カメラの高さ 1m あたりに地面の半径を広げる量(m)。既定 1.8（仰角 55° 前後の俯瞰で画面の端まで敷ける）。 */
  groundRadiusPerHeight?: number;
  /** 航空写真の最も粗いタイル（ズーム10）を要求する範囲。既定 `ORTHO_ROOT_BOUNDS`。 */
  groundRootBounds?: { west: number; south: number; east: number; north: number };
}

/**
 * 航空写真（PLATEAU-Ortho、ズーム10）が揃っている範囲（23区とその周り）。
 * これより外の最も粗いタイルは 404 になるので要求しない。2026-11 にズーム10 のタイルの有無を調べて決めた。
 */
export const ORTHO_ROOT_BOUNDS = { west: 139.22, south: 35.47, east: 140.27, north: 36.03 } as const;

/** 連続でこのフレーム数だけ読み込み待ちがなければ「出そろった」とみなす。 */
const SETTLE_FRAMES = 10;

interface ResolvedFocus {
  lat: number;
  lon: number;
  detailRadiusM: number;
  outerRadiusM: number;
}

function resolveFocus(f: PlateauFocus): ResolvedFocus {
  return { lat: f.lat, lon: f.lon, detailRadiusM: f.detailRadiusM ?? 250, outerRadiusM: f.outerRadiusM ?? 1500 };
}

function sameFocus(a: ResolvedFocus, b: ResolvedFocus): boolean {
  return a.lat === b.lat && a.lon === b.lon && a.detailRadiusM === b.detailRadiusM && a.outerRadiusM === b.outerRadiusM;
}

export interface PlateauCityStatus {
  focus: ResolvedFocus;
  /** 区ごとの層の数（テクスチャ付き・なし）。 */
  wards: { detail: number; outer: number };
  buildingsVisible: boolean;
  buildingsLoading: boolean;
  groundLoading: boolean;
  groundTiles: number;
  /** 読み込みが止まって出そろっているか。 */
  settled: boolean;
}

export class PlateauCity {
  readonly ground: PlateauGround;
  /** 建物と地面の初回読み込みが終わると解決する。 */
  readonly ready: Promise<void>;
  private readonly options: PlateauCityOptions;
  private readonly draco = new DRACOLoader();
  /** tileset の URL ごとの層。 */
  private readonly detail = new Map<string, PlateauBuildings>();
  private readonly outer = new Map<string, PlateauBuildings>();
  private current: ResolvedFocus;
  private quietFrames = 0;
  private wasVisible: boolean | null = null;

  constructor(options: PlateauCityOptions) {
    this.options = options;
    this.draco.setDecoderPath(DRACO_GLTF_CONFIG);
    this.ground = new PlateauGround({
      camera: options.camera,
      renderer: options.renderer,
      radiusM: options.groundMinRadiusM ?? 6000,
      rootBounds: options.groundRootBounds ?? ORTHO_ROOT_BOUNDS,
    });
    options.scene.add(this.ground.group);
    this.current = resolveFocus(options.focus);
    this.applyFocus(this.current);
    const layers = [...this.detail.values(), ...this.outer.values()];
    this.ready = Promise.all([this.ground.ready, ...layers.map((l) => l.ready)]).then(() => undefined);
  }

  /** 今の場所。 */
  get focus(): ResolvedFocus {
    return this.current;
  }

  /**
   * 建物を読む場所を変える。テクスチャ付きの円を新しい中心へ移し、新しく掛かる区だけ読み込みを足し、
   * 掛からなくなった区は破棄する。変わったら true。
   */
  setFocus(focus: PlateauFocus): boolean {
    const next = resolveFocus(focus);
    if (sameFocus(next, this.current)) return false;
    this.current = next;
    this.applyFocus(next);
    this.quietFrames = 0;
    return true;
  }

  /** 描画の前に呼ぶ。 */
  update(): void {
    const { camera } = this.options;
    const h = Math.max(camera.position.y, 0);
    this.ground.radiusM = Math.max(this.options.groundMinRadiusM ?? 6000, h * (this.options.groundRadiusPerHeight ?? 1.8));
    this.ground.update();

    const visible = this.buildingsVisible;
    for (const layer of this.layers()) {
      layer.group.visible = visible;
      if (visible) layer.update();
    }
    if (visible !== this.wasVisible) this.quietFrames = 0;
    this.wasVisible = visible;
    this.quietFrames = this.isLoading ? 0 : this.quietFrames + 1;
  }

  /** 読み込み中のタイルがあれば true（俯瞰で建物を描いていないときは地面だけ）。 */
  get isLoading(): boolean {
    return this.ground.isLoading || (this.buildingsVisible && this.buildingsLoading);
  }

  /** 読み込み中か、読み込みが止まってまだ数フレームしか経っていない（描画を続けるべき）か。 */
  get busy(): boolean {
    return this.quietFrames < SETTLE_FRAMES;
  }

  status(): PlateauCityStatus {
    const visible = this.buildingsVisible;
    return {
      focus: this.current,
      wards: { detail: this.detail.size, outer: this.outer.size },
      buildingsVisible: visible,
      buildingsLoading: visible && this.buildingsLoading,
      groundLoading: this.ground.isLoading,
      groundTiles: this.ground.tileCount,
      settled: !this.busy,
    };
  }

  dispose(): void {
    for (const layer of this.layers()) layer.dispose();
    this.detail.clear();
    this.outer.clear();
    this.ground.dispose();
    this.draco.dispose();
  }

  private get buildingsVisible(): boolean {
    return this.options.camera.position.y < (this.options.buildingsMaxHeightM ?? 7000);
  }

  private get buildingsLoading(): boolean {
    for (const layer of this.layers()) if (layer.isLoading) return true;
    return false;
  }

  private *layers(): Iterable<PlateauBuildings> {
    yield* this.detail.values();
    yield* this.outer.values();
  }

  private applyFocus(f: ResolvedFocus): void {
    const { catalog } = this.options;
    const c = latLonToLocal({ lat: f.lat, lon: f.lon });
    const circle = { x: c.x, z: c.z, radiusM: f.detailRadiusM };
    this.syncLayers(this.detail, selectTilesets(catalog, f.lat, f.lon, f.detailRadiusM, 'lod2_texture'), circle, 'inside');
    this.syncLayers(this.outer, selectTilesets(catalog, f.lat, f.lon, f.outerRadiusM, 'lod2_no_texture'), circle, 'outside');
  }

  private syncLayers(
    layers: Map<string, PlateauBuildings>,
    urls: readonly string[],
    circle: { x: number; z: number; radiusM: number },
    side: 'inside' | 'outside',
  ): void {
    const wanted = new Set(urls);
    for (const [url, layer] of layers) {
      if (wanted.has(url)) continue;
      layer.dispose();
      layers.delete(url);
    }
    for (const url of urls) {
      const existing = layers.get(url);
      if (existing) {
        existing.setArea(circle);
        continue;
      }
      const { camera, renderer, scene } = this.options;
      const layer = new PlateauBuildings({
        urls: [url],
        camera,
        renderer,
        area: { ...circle, side },
        dracoLoader: this.draco,
        ...(side === 'outside' ? { errorTarget: this.options.outerErrorTarget ?? 32 } : {}),
      });
      layer.group.visible = this.buildingsVisible;
      scene.add(layer.group);
      layers.set(url, layer);
    }
  }
}

/** カメラの高さ(m)に合わせた霧の範囲。俯瞰でも街が霞みすぎず、地平線の近くでは地面の端を隠す。 */
export function fogRangeForHeight(heightM: number): { near: number; far: number } {
  const h = Math.max(heightM, 0);
  return { near: 1500 + h * 1.5, far: 6000 + h * 5 };
}

export interface PlateauStageOptions {
  container: HTMLElement;
  /** 視点の中心（注視点）。 */
  center: { lat: number; lon: number };
  /** 注視点から見たカメラの位置(m)。X=東, Y=上, Z=南。既定は東・南東の上空から西を見下ろす。 */
  cameraOffset?: { x: number; y: number; z: number };
  /** 注視点からこの半径(m)は LOD2 テクスチャ付きの建物を最も細かいタイルまで読む。既定 250。 */
  detailRadiusM?: number;
  /** その外側は LOD2 テクスチャなしの建物を視点からの距離に応じて読む。この半径(m)に掛かる区が対象。既定 1500。 */
  outerRadiusM?: number;
  /** 外側の建物の画面上の許容誤差(px)。大きいほど読む量が減る。既定 32。 */
  outerErrorTarget?: number;
  catalog?: PlateauCatalog;
}

export interface PlateauStage {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  city: PlateauCity;
  ground: PlateauGround;
  /** 建物と地面の初回読み込みが終わると解決する。 */
  ready: Promise<void>;
  /** 建物を読む場所を変える（`PlateauCity.setFocus`）。 */
  setFocus(focus: PlateauFocus): boolean;
  /** 1 フレーム更新して描画する。 */
  render(): void;
  dispose(): void;
}

const SKY_COLOR = 0xbfd9ee;
const DEFAULT_OFFSET = { x: 380, y: 560, z: 360 };

export async function createPlateauStage(options: PlateauStageOptions): Promise<PlateauStage> {
  const { container, center } = options;
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(SKY_COLOR);
  const fog = new Fog(SKY_COLOR, 2500, 9000);
  scene.fog = fog;

  const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 40000);

  scene.add(new HemisphereLight(0xeef4ff, 0x8a8170, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(-300, 600, 400);
  scene.add(sun);

  const catalog = options.catalog ?? (await loadPlateauCatalog());
  const city = new PlateauCity({
    scene,
    camera,
    renderer,
    catalog,
    focus: { ...center, detailRadiusM: options.detailRadiusM, outerRadiusM: options.outerRadiusM },
    outerErrorTarget: options.outerErrorTarget,
  });

  // 注視点の高さは標高タイルから取る（渋谷など起伏のある場所で地面に合わせるため）
  const centerHeight = await city.ground.elevation.elevationAt(center.lat, center.lon);
  const target = latLonToLocal({ lat: center.lat, lon: center.lon, alt: centerHeight });
  const offset = options.cameraOffset ?? DEFAULT_OFFSET;
  camera.position.set(target.x + offset.x, target.y + offset.y, target.z + offset.z);
  camera.lookAt(target.x, target.y, target.z);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(target.x, target.y, target.z);
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 20;
  controls.maxDistance = 40000;
  controls.enableDamping = true;
  controls.update();

  const attribution = addAttribution(container);

  const onResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  const render = (): void => {
    controls.update();
    // near / far と霧をカメラの高さに合わせる（俯瞰で深度の分解能が足りなくなり、霧で街が消えるのを防ぐ）
    const h = Math.max(camera.position.y - target.y, 1);
    const near = Math.max(1, Math.min(h, camera.position.distanceTo(controls.target)) * 0.05);
    const far = Math.max(40000, h * 20);
    if (camera.near !== near || camera.far !== far) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    const range = fogRangeForHeight(h);
    fog.near = Math.max(2500, range.near);
    fog.far = Math.max(9000, range.far);
    city.update();
    renderer.render(scene, camera);
  };

  const dispose = (): void => {
    window.removeEventListener('resize', onResize);
    controls.dispose();
    city.dispose();
    attribution.remove();
    renderer.dispose();
    renderer.domElement.remove();
  };

  return {
    renderer,
    scene,
    camera,
    controls,
    city,
    ground: city.ground,
    ready: city.ready,
    setFocus: (f) => city.setFocus(f),
    render,
    dispose,
  };
}
