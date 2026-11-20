/**
 * PLATEAU の街並み（建物 3D Tiles ＋ 航空写真の地面）を表示する舞台一式。
 * 確認ページ（demos/plateau）と本編の両方から使う。
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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { latLonToLocal } from '../../geo/enu';
import { addAttribution } from './attribution';
import { PlateauBuildings } from './buildings';
import { loadPlateauCatalog, selectTilesets } from './catalog';
import type { PlateauCatalog } from './catalog';
import { PlateauGround } from './ground';

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
  /** 注視点の近く（テクスチャ付き）。 */
  buildings: PlateauBuildings;
  /** その外側（テクスチャなし）。 */
  outerBuildings: PlateauBuildings;
  ground: PlateauGround;
  /** 建物と地面の初回読み込みが終わると解決する。 */
  ready: Promise<void>;
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
  scene.fog = new Fog(SKY_COLOR, 2500, 9000);

  const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 40000);

  scene.add(new HemisphereLight(0xeef4ff, 0x8a8170, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(-300, 600, 400);
  scene.add(sun);

  const ground = new PlateauGround({ camera, renderer });
  scene.add(ground.group);

  // 注視点の高さは標高タイルから取る（渋谷など起伏のある場所で地面に合わせるため）
  const [catalog, centerHeight] = await Promise.all([
    options.catalog ?? loadPlateauCatalog(),
    ground.elevation.elevationAt(center.lat, center.lon),
  ]);
  const target = latLonToLocal({ lat: center.lat, lon: center.lon, alt: centerHeight });
  const offset = options.cameraOffset ?? DEFAULT_OFFSET;
  camera.position.set(target.x + offset.x, target.y + offset.y, target.z + offset.z);
  camera.lookAt(target.x, target.y, target.z);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(target.x, target.y, target.z);
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 20;
  controls.maxDistance = 8000;
  controls.enableDamping = true;
  controls.update();

  const detailRadiusM = options.detailRadiusM ?? 250;
  const buildings = new PlateauBuildings({
    urls: selectTilesets(catalog, center.lat, center.lon, detailRadiusM, 'lod2_texture'),
    camera,
    renderer,
    area: { x: target.x, z: target.z, radiusM: detailRadiusM, side: 'inside' },
  });
  const outerBuildings = new PlateauBuildings({
    urls: selectTilesets(catalog, center.lat, center.lon, options.outerRadiusM ?? 1500, 'lod2_no_texture'),
    camera,
    renderer,
    area: { x: target.x, z: target.z, radiusM: detailRadiusM, side: 'outside' },
    errorTarget: options.outerErrorTarget ?? 32,
  });
  scene.add(buildings.group, outerBuildings.group);

  const attribution = addAttribution(container);

  const onResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  const render = (): void => {
    controls.update();
    buildings.update();
    outerBuildings.update();
    ground.update();
    renderer.render(scene, camera);
  };

  const dispose = (): void => {
    window.removeEventListener('resize', onResize);
    controls.dispose();
    buildings.dispose();
    outerBuildings.dispose();
    ground.dispose();
    attribution.remove();
    renderer.dispose();
    renderer.domElement.remove();
  };

  const ready = Promise.all([buildings.ready, outerBuildings.ready, ground.ready]).then(() => undefined);
  return { renderer, scene, camera, controls, buildings, outerBuildings, ground, ready, render, dispose };
}
