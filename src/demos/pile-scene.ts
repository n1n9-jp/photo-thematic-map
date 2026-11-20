/**
 * 確認ページ: PLATEAU の街並みの上に、実数ぶんの自転車が降って積もる山の場面。
 *
 * URL パラメータ
 * - site: marunouchi（1年ぶん 187,262台・全台）| shinjuku（15年ぶん 5,798,477台・表層だけ）。既定 marunouchi。
 * - t: 進み具合 0〜1（既定 1）。1 未満のときは「スクロールし続けている途中」の状態で止める（落下中の自転車が空中にいる）。
 * - view: wide | close | street（既定 wide）。
 * - play=1: 進み具合を 0 から 1 へ自動で進める（12 秒）。
 * - reduced=1: 動きを減らす設定（落下を省く）。
 */
import { DataUtils, type Vector3Tuple } from 'three';
import { GRID_PILE_TRIALS, type GridName } from '../data/grids';
import { latLonToLocal } from '../geo/enu';
import { createPileScene, type PileScene } from '../scene/pileScene/pileScene';
import type { PileComputeProgress } from '../scene/pileScene/compute';
import { createPlateauStage } from '../scene/plateau/stage';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・手動確認用の結果。 */
    __PILE_SCENE__?: {
      site: string;
      view: string;
      progress: number;
      represented: number;
      placed: number;
      shown: number;
      falling: number;
      triangles: number;
      bikeTriangles: number;
      shellTriangles: number;
      perLod: [number, number, number];
      frameUploadBytes: number;
      maxFrameUploadBytes: number;
      apexY: number;
      apexHeight: number;
      siteLocal: { x: number; z: number; groundY: number };
      timings: { loadMs: number; depositMs: number; fillMs: number; prepareMs: number; totalMs: number; wallMs: number };
      fill: { overTop: number; maxBelowGround: number; wallContacts: number };
    };
  }
}

interface SiteDef {
  grid: GridName;
  count: number;
  mode: 'full' | 'surface';
  label: string;
}

const SITES: Record<string, SiteDef> = {
  marunouchi: { grid: 'marunouchi', count: 187_262, mode: 'full', label: '1年ぶん（2024年度）' },
  shinjuku: { grid: 'shinjuku', count: 5_798_477, mode: 'surface', label: '15年ぶん（2010〜2024年度）' },
};
/** 都庁第一本庁舎。 */
const TOCHO = { lat: 35.6895, lon: 139.69175 };

const params = new URLSearchParams(location.search);
const siteName = params.get('site') === 'shinjuku' ? 'shinjuku' : 'marunouchi';
const site = SITES[siteName]!;
const trial = GRID_PILE_TRIALS[site.grid]!;
const viewName = ['wide', 'close', 'street'].includes(params.get('view') ?? '') ? params.get('view')! : 'wide';
const tParam = Number(params.get('t'));
const progressParam = params.has('t') && Number.isFinite(tParam) ? Math.min(1, Math.max(0, tParam)) : 1;
const play = params.get('play') === '1';
const reduced = params.has('reduced') ? params.get('reduced') === '1' : undefined;

const container = document.getElementById('app');
const infoEl = document.getElementById('info');
if (!container) throw new Error('#app が見つかりません');
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

const tStart = performance.now();
let computeProgress: PileComputeProgress = { phase: 'load', fraction: 0 };
const pilePromise = createPileScene({
  grid: site.grid,
  lat: trial.lat,
  lon: trial.lon,
  count: site.count,
  mode: site.mode,
  reducedMotion: reduced,
  onProgress: (p) => {
    computeProgress = p;
    if (infoEl) infoEl.textContent = `山を計算中… ${p.phase} ${Math.round(p.fraction * 100)}%`;
  },
});
const stagePromise = createPlateauStage({ container, center: { lat: trial.lat, lon: trial.lon }, detailRadiusM: siteName === 'shinjuku' ? 400 : 300 });
const [pile, stage] = await Promise.all([pilePromise, stagePromise]);
const wallMs = performance.now() - tStart;
void computeProgress;

// 視点
const res = pile.result;
const lw = res.layerWidth;
const lh = res.layerHeight;
const finalLayer = res.layers.subarray((res.fractions.length - 1) * lw * lh);
const cs = res.layerRect.cellSize;
/** 最終の山の厚さと地表（屋上を含む）の高さ。 */
function finalAt(x: number, z: number): { thick: number; ground: number } {
  const c = Math.floor((x - res.layerRect.x0) / cs);
  const r = Math.floor((z - res.layerRect.z0) / cs);
  if (c < 0 || r < 0 || c >= lw || r >= lh) return { thick: 0, ground: res.site.groundY };
  return { thick: DataUtils.fromHalfFloat(finalLayer[r * lw + c]!), ground: res.layerGround[r * lw + c]! };
}
const sx = res.site.x;
const sz = res.site.z;
const g0 = res.site.groundY;
const apexY = pile.info.apexY;
/** 方向 (dx, dz) へ投入点から進んで、山の裾（厚さ 0.3m 未満）に達する位置。 */
function footAlong(dx: number, dz: number): { x: number; z: number; y: number } {
  const l = Math.hypot(dx, dz);
  const ux = dx / l;
  const uz = dz / l;
  let d = 0;
  for (; d < 600; d += 0.5) {
    if (finalAt(sx + ux * d, sz + uz * d).thick < 0.3) break;
  }
  const x = sx + ux * d;
  const z = sz + uz * d;
  return { x, z, y: finalAt(x, z).ground };
}

// 丸の内: 行幸通りの軸（駅舎から西北西へ。格子で建物に遮られない向きを調べた値）
let east: [number, number] = [Math.cos((15 * Math.PI) / 180), Math.sin((15 * Math.PI) / 180)];
if (siteName === 'shinjuku') {
  const t = latLonToLocal(TOCHO);
  east = [t.x - sx, t.z - sz];
}
const el = Math.hypot(east[0], east[1]);
const ux = east[0] / el;
const uz = east[1] / el;
const foot = footAlong(-ux, -uz); // 西側の裾
/** 方向 (px, pz) の裾を、外側 dist(m)・高さ h(m) から斜めに見下ろす。 */
function closeFrom(dir: [number, number], dist: number, h: number): { pos: Vector3Tuple; target: Vector3Tuple } {
  const f = footAlong(dir[0], dir[1]);
  return { pos: [f.x + dir[0] * dist, f.y + h, f.z + dir[1] * dist], target: [f.x - dir[0] * 20, f.y + 6, f.z - dir[1] * 20] };
}
const VIEWS: Record<string, { pos: Vector3Tuple; target: Vector3Tuple }> =
  siteName === 'shinjuku'
    ? {
        // 公園の西側から東を向き、山の後ろに都庁
        wide: { pos: [sx - ux * 850, g0 + 150, sz - uz * 850], target: [sx + ux * 60, g0 + 70, sz + uz * 60] },
        close: closeFrom(params.get('side') === 'n' ? [uz, -ux] : [-uz, ux], 45, 32),
        street: { pos: [foot.x - ux * 14, foot.y + 1.6, foot.z - uz * 14], target: [sx, g0 + 35, sz] },
      }
    : {
        // 行幸通りの西側から東を向き、山の後ろに丸の内駅舎
        wide: { pos: [sx - ux * 300, g0 + 80, sz - uz * 300], target: [sx + ux * 40, g0 + 24, sz + uz * 40] },
        close: { pos: [foot.x - ux * 22 + uz * 8, foot.y + 13, foot.z - uz * 22 - ux * 8], target: [foot.x + ux * 10, foot.y + 3, foot.z + uz * 10] },
        street: { pos: [foot.x - ux * 11, foot.y + 1.6, foot.z - uz * 11], target: [sx, g0 + 13, sz] },
      };
const view = VIEWS[viewName]!;
stage.camera.position.set(...view.pos);
stage.controls.target.set(...view.target);
stage.camera.near = viewName === 'wide' ? 1 : 0.3;
stage.camera.updateProjectionMatrix();
stage.controls.minDistance = 2;
stage.controls.update();

// 進み具合
/** 自動再生は街並みの読み込みが終わってから始める。 */
let playStart = Infinity;
const PLAY_SECONDS = 12;
if (play) pile.setProgress(0);
else if (progressParam < 1) {
  pile.setProgress(progressParam, { midair: true });
  pile.pauseFalls = true;
} else pile.setProgress(1);

let maxUpload = 0;
function updateInfo(): void {
  const s = pile.stats;
  const f = s.field;
  const tm = pile.info.timings;
  const text =
    `${siteName}（${site.label}）${site.mode === 'surface' ? '表層だけ' : '全台'} / 進み具合 ${pile.progress.toFixed(3)}\n` +
    `表す台数     ${fmt(s.represented)} / ${fmt(pile.info.representedCount)}\n` +
    `置いた台数   ${fmt(pile.info.placedCount)}\n` +
    `表示中の台数 ${fmt(s.shown)}（落下中 ${fmt(s.falling)}）\n` +
    `三角形       ${fmt(s.triangles)}（自転車 ${fmt(f.triangles)} 近/中/遠 ${fmt(f.perLod[0])}/${fmt(f.perLod[1])}/${fmt(f.perLod[2])}、暗い面 ${fmt(s.shellTriangles)}）\n` +
    `転送         ${fmt(f.frameUploadBytes)} B/フレーム（最大 ${fmt(maxUpload)}）\n` +
    `頂上         標高 ${apexY.toFixed(1)} m（地表から ${pile.info.apexHeight.toFixed(1)} m）\n` +
    `計算 ms      読込 ${fmt(tm.loadMs)} / 堆積 ${fmt(tm.depositMs)} / 充填 ${fmt(tm.fillMs)} / 準備 ${fmt(tm.prepareMs)}（計 ${fmt(tm.totalMs)}、待ち ${fmt(wallMs)}）`;
  if (infoEl) infoEl.textContent = text;
}

let frames = 0;
function frame(): void {
  if (play) {
    const t = Math.min(1, Math.max(0, (performance.now() - playStart) / 1000 / PLAY_SECONDS));
    if (t !== pile.progress) pile.setProgress(t);
  }
  pile.update(stage.camera, stage.renderer.domElement.height / stage.renderer.getPixelRatio());
  stage.render();
  frames++;
  // 最初の数フレーム（登録時の転送）は除いて最大を記録する
  if (frames > 3) maxUpload = Math.max(maxUpload, pile.stats.field.frameUploadBytes);
  updateInfo();
  const s = pile.stats;
  window.__PILE_SCENE__ = {
    site: siteName,
    view: viewName,
    progress: pile.progress,
    represented: s.represented,
    placed: pile.info.placedCount,
    shown: s.shown,
    falling: s.falling,
    triangles: s.triangles,
    bikeTriangles: s.field.triangles,
    shellTriangles: s.shellTriangles,
    perLod: [...s.field.perLod],
    frameUploadBytes: s.field.frameUploadBytes,
    maxFrameUploadBytes: maxUpload,
    apexY,
    apexHeight: pile.info.apexHeight,
    siteLocal: { x: sx, z: sz, groundY: g0 },
    timings: { ...pile.info.timings, wallMs },
    fill: { overTop: pile.info.fillStats.overTop, maxBelowGround: pile.info.fillStats.maxBelowGround, wallContacts: pile.info.fillStats.wallContacts },
  };
}

stage.renderer.setAnimationLoop(frame);
(window as unknown as { __PTM_PILE__: PileScene }).__PTM_PILE__ = pile;
// 街並みの初回読み込みが終わってから山を加える（読み込み中のフレームを軽くする）
await stage.ready;
stage.scene.add(pile.object);
playStart = performance.now();
frame();
requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
