/**
 * PLATEAU の街並み（建物 3D Tiles ＋ 航空写真の地面）を表示する舞台一式。
 *
 * - `PlateauCity`: 既存のシーンに足す街並み。建物は白で描く（写真テクスチャは使わない）。建物の読み方は 2 つ:
 *   - `buildings: 'baked'`（本編の既定）: 変換済みの建物（`public/data/buildings/`。`npm run data:buildings`）を
 *     `BakedBuildings` で読む。カメラの位置に応じて必要なチャンクだけを読む。
 *   - `buildings: 'live'`（既定。確認ページ demos/plateau と、本編の `?buildings=live`）: PLATEAU の配信サーバーから
 *     LOD2 テクスチャなし（lod2_no_texture）の 3D Tiles を直接読む。詳細度は画面上の誤差で選ぶので、遠くの建物は粗いタイルで済む。
 *     `setFocus()` で読み込む区を差し替えられる（本編はカメラの注視点＝場面の場所に合わせて切り替える）。
 *   地面の半径と建物の表示はカメラの高さに合わせて変える（高さ 28km の俯瞰では建物を描かず、地面を23区全体に敷く）。
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
import { BakedBuildings, type BakedBuildingsStats } from './bakedBuildings';
import { PlateauBuildings, createBuildingLruCache } from './buildings';
import { loadPlateauCatalog, selectTilesets } from './catalog';
import type { PlateauCatalog } from './catalog';
import { PlateauGround } from './ground';

/** 建物を読む場所。 */
export interface PlateauFocus {
  lat: number;
  lon: number;
  /** この半径(m)に掛かる区の建物を読む。既定 1500。 */
  radiusM?: number;
}

export interface PlateauCityOptions {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** PLATEAU の tileset 一覧。`buildings: 'live'` のときに要る。 */
  catalog?: PlateauCatalog;
  focus: PlateauFocus;
  /** 建物の読み方。'baked' は変換済みのデータ、'live' は PLATEAU から直接。既定 'live'。 */
  buildings?: 'baked' | 'live';
  /** 'baked' のとき、この点（注視点）の周りも詳細にする。 */
  lookAt?: () => { x: number; z: number } | null;
  /** 建物の画面上の許容誤差(px)。大きいほど読む量が減る。既定 24。 */
  errorTarget?: number;
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

/** 建物の画面上の許容誤差(px)の既定値。 */
const DEFAULT_ERROR_TARGET = 24;

interface ResolvedFocus {
  lat: number;
  lon: number;
  radiusM: number;
}

function resolveFocus(f: PlateauFocus): ResolvedFocus {
  return { lat: f.lat, lon: f.lon, radiusM: f.radiusM ?? 1500 };
}

function sameFocus(a: ResolvedFocus, b: ResolvedFocus): boolean {
  return a.lat === b.lat && a.lon === b.lon && a.radiusM === b.radiusM;
}

export interface PlateauCityStatus {
  focus: ResolvedFocus;
  /** 建物の読み方。 */
  buildingSource: 'baked' | 'live';
  /** 読み込んでいる区の数（'live'）。 */
  wards: number;
  /** 変換済みの建物の状態（'baked'）。 */
  baked: BakedBuildingsStats | null;
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
  /** 全区の層で共有する LRU キャッシュ（上限は端末に合わせる）。 */
  private readonly lruCache = createBuildingLruCache();
  /** tileset の URL（区）ごとの層。 */
  private readonly layers = new Map<string, PlateauBuildings>();
  /** 変換済みの建物（'baked'）。 */
  private readonly baked: BakedBuildings | null = null;
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
    if (options.buildings === 'baked') {
      const camera = options.camera;
      this.baked = new BakedBuildings({
        camera,
        lookAt: options.lookAt,
        maxDistanceM: () => bakedBuildingsMaxDistanceForHeight(camera.position.y),
      });
      this.baked.group.visible = this.buildingsVisible;
      options.scene.add(this.baked.group);
    } else {
      if (!options.catalog) throw new Error('PlateauCity: buildings が live のときは catalog が要ります');
      this.applyFocus(this.current);
    }
    this.ready = Promise.all([this.ground.ready, ...[...this.layers.values()].map((l) => l.ready), this.baked?.ready]).then(() => undefined);
  }

  /** 今の場所。 */
  get focus(): ResolvedFocus {
    return this.current;
  }

  /** 建物を読む場所を変える。新しく掛かる区だけ読み込みを足し、掛からなくなった区は破棄する。変わったら true。 */
  setFocus(focus: PlateauFocus): boolean {
    const next = resolveFocus(focus);
    if (sameFocus(next, this.current)) return false;
    this.current = next;
    if (!this.baked) this.applyFocus(next);
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
    for (const layer of this.layers.values()) {
      layer.group.visible = visible;
      if (visible) layer.update();
    }
    if (this.baked) {
      this.baked.group.visible = visible;
      if (visible) this.baked.update();
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

  /** 区ごとの建物の層。 */
  get buildingLayers(): PlateauBuildings[] {
    return [...this.layers.values()];
  }

  /** 取得できなかったタイルの数（建物・航空写真・標高）。 */
  get failedTileCount(): { buildings: number; ground: number; elevation: number } {
    let buildings = this.baked?.failedCount ?? 0;
    for (const layer of this.layers.values()) buildings += layer.failedTileCount;
    return { buildings, ground: this.ground.failedTileCount, elevation: this.ground.failedElevationTileCount };
  }

  /** 取得できなかったタイルを取り直す（配信サーバーに再び接続できたときなど）。 */
  retryFailedTiles(): void {
    for (const layer of this.layers.values()) layer.retryFailedTiles();
    this.ground.retryFailedTiles();
    this.quietFrames = 0;
  }

  status(): PlateauCityStatus {
    const visible = this.buildingsVisible;
    return {
      focus: this.current,
      buildingSource: this.baked ? 'baked' : 'live',
      wards: this.layers.size,
      baked: this.baked?.stats() ?? null,
      buildingsVisible: visible,
      buildingsLoading: visible && this.buildingsLoading,
      groundLoading: this.ground.isLoading,
      groundTiles: this.ground.tileCount,
      settled: !this.busy,
    };
  }

  dispose(): void {
    for (const layer of this.layers.values()) layer.dispose();
    this.layers.clear();
    this.baked?.dispose();
    this.ground.dispose();
    this.draco.dispose();
  }

  private get buildingsVisible(): boolean {
    return this.options.camera.position.y < (this.options.buildingsMaxHeightM ?? 7000);
  }

  private get buildingsLoading(): boolean {
    for (const layer of this.layers.values()) if (layer.isLoading) return true;
    return this.baked?.isLoading ?? false;
  }

  /** 変換済みの建物の層（'baked' のとき）。 */
  get bakedBuildings(): BakedBuildings | null {
    return this.baked;
  }

  private applyFocus(f: ResolvedFocus): void {
    const { catalog, camera, renderer, scene } = this.options;
    if (!catalog) return;
    const urls = selectTilesets(catalog, f.lat, f.lon, f.radiusM, 'lod2_no_texture');
    const wanted = new Set(urls);
    for (const [url, layer] of this.layers) {
      if (wanted.has(url)) continue;
      layer.dispose();
      this.layers.delete(url);
    }
    for (const url of urls) {
      if (this.layers.has(url)) continue;
      const layer = new PlateauBuildings({
        urls: [url],
        camera,
        renderer,
        dracoLoader: this.draco,
        lruCache: this.lruCache,
        errorTarget: this.options.errorTarget ?? DEFAULT_ERROR_TARGET,
        maxDistanceM: () => buildingsMaxDistanceForHeight(camera.position.y),
      });
      layer.group.visible = this.buildingsVisible;
      scene.add(layer.group);
      this.layers.set(url, layer);
    }
  }
}

/**
 * カメラの高さ(m)に合わせた、建物を読む距離の上限(m)。霧が6割ほど掛かる距離。これより遠い建物は霧でほぼ見えず、
 * 区の範囲の矩形が広い区（江東区など）の地平線近くの粗いタイル（1つ数MB〜10MB）を読まずに済む。
 */
export function buildingsMaxDistanceForHeight(heightM: number): number {
  const { near, far } = fogRangeForHeight(heightM);
  return near + (far - near) * 0.35;
}

/**
 * 変換済みの建物（'baked'）の遠景を読む距離の上限(m)。霧が 6 割掛かる距離（地上で約 4.2km）。
 * 遠景は高い建物の箱だけで軽いので、直接読む経路（{@link buildingsMaxDistanceForHeight}）より遠くまで読み、
 * 地平線の近くまで街並みが続いて見えるようにする。変換した範囲（manifest の levels.far.viewDistanceM）でも制限される。
 */
export function bakedBuildingsMaxDistanceForHeight(heightM: number): number {
  const { near, far } = fogRangeForHeight(heightM);
  return near + (far - near) * 0.6;
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
  /** 注視点からこの半径(m)に掛かる区の建物を読む。既定 1500。 */
  radiusM?: number;
  /** 建物の画面上の許容誤差(px)。大きいほど読む量が減る。既定 24。 */
  errorTarget?: number;
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
    focus: { ...center, radiusM: options.radiusM },
    errorTarget: options.errorTarget,
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
