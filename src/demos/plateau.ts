/**
 * 確認ページ: PLATEAU の建物 3D Tiles と航空写真の地面。
 * 初期視点は東京駅の上空から丸の内のビル群を斜めに見下ろす。`?lat=..&lon=..` で視点の中心を変えられる。
 */
import { ORIGIN } from '../config';
import { createPlateauStage } from '../scene/plateau/stage';

declare global {
  interface Window {
    __APP_READY__?: boolean;
  }
}

/** 既定の注視点: 丸の内（東京駅の丸の内駅舎の西側）。 */
const MARUNOUCHI = { lat: 35.6814, lon: ORIGIN.lon - 0.0012 };

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

// ?detail=（テクスチャ付きの半径 m）と ?outerError=（外側の許容誤差 px）は読み込み量の調整用
const stage = await createPlateauStage({
  container,
  center: centerFromQuery(),
  cameraOffset: viewFromQuery(),
  detailRadiusM: numberParam('detail'),
  outerErrorTarget: numberParam('outerError'),
});
stage.renderer.setAnimationLoop(stage.render);
(window as unknown as { __PTM_STAGE__: unknown }).__PTM_STAGE__ = stage;

await stage.ready;
stage.render();
requestAnimationFrame(() => {
  console.info(`PLATEAU 初回読み込み完了: ${Math.round(performance.now() - t0)} ms`);
  window.__APP_READY__ = true;
});
