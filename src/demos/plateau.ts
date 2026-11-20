/**
 * 確認ページ: PLATEAU の建物 3D Tiles と航空写真の地面。
 * 初期視点は東京駅の上空から丸の内のビル群を斜めに見下ろす。`?lat=..&lon=..` で視点の中心を変えられる。
 *
 * 計測・検証用に window へ次を公開する。
 * - `__PTM_STAGE__`: 舞台（PlateauStage）
 * - `__PTM_GOTO__(name)`: カメラを本編の場面（SCENES のキー）へ移す。`?scene=name` でも初期視点にできる。
 * - `__PTM_STATS__()`: テクスチャ数・タイル数・読み込み中かどうか・失敗したタイル数
 * - `__PTM_DISPOSE__()`: 描画ループを止めて舞台を破棄する
 */
import { ORIGIN } from '../config';
import { latLonToLocal } from '../geo/enu';
import { createPlateauStage } from '../scene/plateau/stage';
import type { PlateauStage } from '../scene/plateau/stage';

declare global {
  interface Window {
    __APP_READY__?: boolean;
  }
}

/** 既定の注視点: 丸の内（東京駅の丸の内駅舎の西側）。 */
const MARUNOUCHI = { lat: 35.6814, lon: ORIGIN.lon - 0.0012 };

interface SceneView {
  /** カメラの位置と、その地点の地面からの高さ(m)。 */
  eye: { lat: number; lon: number; height: number };
  /** 注視点と、その地点の地面からの高さ(m)。 */
  target: { lat: number; lon: number; height: number };
}

/** 本編の場面（カメラの位置と注視点）。 */
const SCENES: Record<string, SceneView> = {
  'akihabara-ground': {
    eye: { lat: 35.6979, lon: 139.7729, height: 1.6 },
    target: { lat: 35.69836, lon: 139.77313, height: 3 },
  },
  'akihabara-sky': {
    eye: { lat: 35.6972, lon: 139.7745, height: 100 },
    target: { lat: 35.69836, lon: 139.77313, height: 0 },
  },
  overview: {
    eye: { lat: 35.66, lon: 139.75, height: 28000 },
    target: { lat: 35.69, lon: 139.75, height: 0 },
  },
  'tokyo-marunouchi': {
    eye: { lat: 35.6812, lon: 139.7647, height: 1.6 },
    target: { lat: 35.6812, lon: 139.766, height: 10 },
  },
  'kokyo-gaien': {
    eye: { lat: 35.68, lon: 139.757, height: 50 },
    target: { lat: 35.6835, lon: 139.753, height: 0 },
  },
  'tokyo-front': {
    eye: { lat: 35.6805, lon: 139.765, height: 30 },
    target: { lat: 35.6812, lon: 139.7671, height: 0 },
  },
};

const query = new URLSearchParams(location.search);

/** 数値のクエリ（無ければ undefined）。 */
function numberParam(name: string): number | undefined {
  const v = Number(query.get(name));
  return query.has(name) && Number.isFinite(v) ? v : undefined;
}

function centerFromQuery(): { lat: number; lon: number } {
  const q = query;
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (q.has('lat') && q.has('lon') && Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  return MARUNOUCHI;
}

const container = document.getElementById('app');
if (!container) throw new Error('#app が見つかりません');

const t0 = performance.now();
/** ?view=東,上,南（注視点から見たカメラの位置 m）。 */
function viewFromQuery(): { x: number; y: number; z: number } | undefined {
  const v = (query.get('view') ?? '').split(',').map(Number);
  if (v.length !== 3 || !v.every(Number.isFinite)) return undefined;
  const [x, y, z] = v as [number, number, number];
  return { x, y, z };
}

// ?detail=（テクスチャ付きの半径 m）・?outer=（外側の建物を読む半径 m）・?outerError=（外側の許容誤差 px）は読み込み量の調整用
const stage = await createPlateauStage({
  container,
  center: centerFromQuery(),
  cameraOffset: viewFromQuery(),
  detailRadiusM: numberParam('detail'),
  outerRadiusM: numberParam('outer'),
  outerErrorTarget: numberParam('outerError'),
});

/** カメラを場面へ移す。地面の高さは標高タイルから取る。 */
async function goto(name: string): Promise<void> {
  const view = SCENES[name];
  if (!view) throw new Error(`場面がありません: ${name}`);
  const elevation = stage.ground.elevation;
  const [eyeGround, targetGround] = await Promise.all([
    elevation.elevationAt(view.eye.lat, view.eye.lon),
    elevation.elevationAt(view.target.lat, view.target.lon),
  ]);
  const eye = latLonToLocal({ lat: view.eye.lat, lon: view.eye.lon, alt: eyeGround + view.eye.height });
  const target = latLonToLocal({ lat: view.target.lat, lon: view.target.lon, alt: targetGround + view.target.height });
  const { camera, controls } = stage;
  controls.minDistance = 1;
  controls.maxDistance = 60000;
  controls.maxPolarAngle = Math.PI / 2;
  camera.position.set(eye.x, eye.y, eye.z);
  controls.target.set(target.x, target.y, target.z);
  controls.update();
}

interface LayerLike {
  isLoading: boolean;
  tiles?: { stats: { inCache: number; failed: number }; visibleTiles: Set<unknown> }[];
  failedTileCount?: number;
}

/** 計測用の統計。修正前のコードでも読めるよう、公開されていない値は有無を確かめて読む。 */
function stats(s: PlateauStage): Record<string, number | boolean> {
  const layers = [s.buildings, s.outerBuildings] as unknown as LayerLike[];
  const tiles = layers.flatMap((l) => l.tiles ?? []);
  const ground = s.ground as unknown as { tileCount: number; isLoading: boolean; failedTileCount?: number };
  const elevation = s.ground.elevation as unknown as { failedTileCount?: number; size?: number };
  const info = s.renderer.info;
  return {
    loading: layers.some((l) => l.isLoading) || ground.isLoading,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    groundTiles: ground.tileCount,
    buildingTilesInCache: tiles.reduce((sum, t) => sum + t.stats.inCache, 0),
    buildingTilesVisible: tiles.reduce((sum, t) => sum + t.visibleTiles.size, 0),
    demTiles: elevation.size ?? -1,
    groundFailed: ground.failedTileCount ?? -1,
    elevationFailed: elevation.failedTileCount ?? -1,
    buildingsFailed: layers.reduce((sum, l) => sum + (l.failedTileCount ?? 0), 0),
  };
}

const initialScene = query.get('scene');
if (initialScene) await goto(initialScene);

stage.renderer.setAnimationLoop(stage.render);
const w = window as unknown as Record<string, unknown>;
w.__PTM_STAGE__ = stage;
w.__PTM_GOTO__ = goto;
w.__PTM_STATS__ = () => stats(stage);
w.__PTM_DISPOSE__ = () => {
  // 破棄した舞台を描かないよう、描画ループを止めてから破棄する
  stage.renderer.setAnimationLoop(null);
  stage.dispose();
};

await stage.ready;
stage.render();
requestAnimationFrame(() => {
  console.info(`PLATEAU 初回読み込み完了: ${Math.round(performance.now() - t0)} ms`);
  window.__APP_READY__ = true;
});
