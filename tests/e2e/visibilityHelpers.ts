/**
 * 本編の主役（自転車・自転車の山）の「見えている割合」を測り、目標と比べる（main.spec.ts から使う）。
 *
 * 割合は `window.__MAIN__.measureVisibility()`（src/app/visibility.ts）が、画面外の描画先へ描いて画素を数えて求める。
 * - unoccluded: 主役の画素のうち、建物にも地面にも隠れず画面に入っている割合（画面の外の分も「見えていない」に数える）。
 * - clear: さらに本文カードと出典表示にも覆われていない割合。
 * - items（場面2・8 の 462台）: 1台ごとの標本点（3 点）で数えた、建物にも本文カードにも隠れずに見えている台数の割合。
 *   遠くから見下ろす場面では自転車が 1 台 1 画素に満たず、画素の比はカメラのわずかな違いで揺れるので、目標は台数で確かめる。
 * 物差しの建物（丸の内駅舎・都庁第一本庁舎）は、上端と足元の点が画面に入り、カードに覆われていないかで確かめる。
 *
 * 自転車が自転車として見える大きさも確かめる（場面2 の始まりは先頭の1台の全長、場面2 の終わりと場面8 は足元の印の直径）。
 * 場面2 の終わりと場面8 は、462台の広がりが本文カードに覆われていない範囲に収まる最も近い距離（広がりが範囲いっぱいに写る）か、
 * 場面6 は、山の高さが都庁と比べて分かるよう、見下ろす角度（俯角）が浅いかも確かめる。
 */
import type { Page } from '@playwright/test';
import { PLACES } from '../../src/story/content/script';
import { freeRegionFor, type Region } from '../../src/story/layout';

export interface Landmark {
  name: string;
  /** 確かめる点（緯度経度と、地表からの高さ m）。 */
  points: { lat: number; lon: number; heightM: number }[];
}

/** 東京駅 丸の内駅舎（中央の上端と足元）。 */
const MARUNOUCHI: Landmark = {
  name: '丸の内駅舎',
  points: [
    { lat: 35.68124, lon: 139.76695, heightM: 30 },
    { lat: 35.68124, lon: 139.76695, heightM: 1 },
  ],
};

/** 都庁第一本庁舎（上端と足元）。 */
const TOCHO: Landmark = {
  name: '都庁第一本庁舎',
  points: [
    { ...PLACES.tochoFirstBuilding, heightM: 243 },
    { ...PLACES.tochoFirstBuilding, heightM: 1 },
  ],
};

export interface VisibilityGoal {
  /** clear（建物にもカードにも隠れていない割合）の下限。 */
  clear?: number;
  /** unoccluded（建物に隠れていない割合）の下限。 */
  unoccluded?: number;
  /** 1台ごとに数えた、建物にも本文カードにも隠れずに見えている台数の割合（items.clearFraction）の下限。 */
  itemsClear?: number;
  /** 画面に入っている割合（onScreen）の下限。 */
  onScreen?: number;
  /** 主役の画面上の大きさ（囲む長方形の長い辺）の、画面の短い辺に対する割合の下限。 */
  sizeOfShortSide?: number;
  landmark?: Landmark;
  /** 表示中の自転車のうち、本文カード・出典表示に覆われず画面に収まっている台数の割合（items.framedFraction）の下限。 */
  framed?: number;
  /** 置いた順の先頭の1台の、画面上の全長(CSS px)の下限。 */
  firstBikeMinPx?: number;
  /** 足元の印の画面上の直径(CSS px)の下限（表示中で最も遠い印）。 */
  markerMinPx?: number;
  /**
   * 広がりが、本文カードに覆われていない範囲いっぱいに写っているか（最も近い距離か）。標本点を囲む長方形の幅・高さの、
   * 範囲の幅・高さに対する割合の大きい方の下限。
   */
  tightness?: number;
  /** カメラの俯角（見下ろす角度, 度）の上限。 */
  maxElevationDeg?: number;
}

/** 場面2（462台）の始まり・途中・終わり（`measureScene` の phase）。 */
export type ScenePhase = 'start' | 'mid' | 'end';

/**
 * 場面 id（場面2 は id@phase）→ 目標。
 * 場面2 の終わりと場面8 の台数の下限 0.6 は、462台が収まる最も近い距離で、方位と見下ろす角度を選んで届いた値（PC 幅 約 0.69、
 * スマートフォン幅 約 0.77）より低い、後戻りを防ぐための値。最初の目標（0.8）は、自転車が画面で1〜2画素になる遠い距離でしか
 * 届かなかった（自転車は通りの壁際に並ぶので、近いほど斜めの視線になり、建物の向こう側の壁際が隠れる）。
 */
export const VISIBILITY_GOALS: Record<string, VisibilityGoal> = {
  'akihabara-one': { unoccluded: 0.95, clear: 0.95, sizeOfShortSide: 0.2 },
  'akihabara-462@start': { framed: 1, firstBikeMinPx: 12 },
  'akihabara-462@mid': { framed: 0.97 },
  'akihabara-462@end': { itemsClear: 0.6, framed: 0.97, markerMinPx: 6, tightness: 0.85 },
  'removed-fy2024': { unoccluded: 0.9, clear: 0.85, onScreen: 0.98, landmark: MARUNOUCHI },
  'removed-15years': { unoccluded: 0.9, clear: 0.85, onScreen: 0.98, landmark: TOCHO, maxElevationDeg: 30 },
  'after-removal': { unoccluded: 0.9, clear: 0.85, onScreen: 0.98, landmark: MARUNOUCHI },
  'since-1990': { itemsClear: 0.6, framed: 0.97, markerMinPx: 6, tightness: 0.85 },
};

/** 本文カードに覆われていない範囲（画面の座標）。アプリが使う `freeRegionFor` を、いまのカードの位置から求める。 */
export async function freeRegionOf(page: Page): Promise<Region> {
  const info = await page.evaluate(() => {
    let columnRight = 0;
    let coverTop = Number.POSITIVE_INFINITY;
    for (const card of document.querySelectorAll<HTMLElement>('.story-card')) {
      columnRight = Math.max(columnRight, card.getBoundingClientRect().right);
      const top = Number.parseFloat(getComputedStyle(card).top);
      if (Number.isFinite(top)) coverTop = Math.min(coverTop, top);
    }
    const story = document.querySelector('.story')!;
    return {
      side: getComputedStyle(story).getPropertyValue('--story-layout').trim() === 'side',
      width: window.innerWidth,
      height: window.innerHeight,
      columnRight,
      coverTop: Number.isFinite(coverTop) ? coverTop : window.innerHeight,
    };
  });
  return freeRegionFor({
    layout: info.side ? 'side' : 'bottom',
    width: info.width,
    height: info.height,
    visibleHeight: info.height,
    columnRight: info.columnRight,
    coverTop: info.coverTop,
  });
}

export interface VisibilityRow {
  scene: number;
  id: string;
  viewport: string;
  portrait: boolean;
  subjectPixels: number;
  soloPixels: number;
  onScreen: number;
  unoccluded: number;
  clear: number;
  occludedOnScreen: number;
  /** 主役を囲む長方形の長い辺 ÷ 画面の短い辺。 */
  sizeOfShortSide: number;
  bbox: { left: number; top: number; right: number; bottom: number } | null;
  buildingShare: number | null;
  /** 1台ごとに数えた台数（場面2・8）。 */
  items: { total: number; visible: number; clear: number; visibleFraction: number; clearFraction: number; framed: number; framedFraction: number } | null;
  /** 秋葉原の自転車の画面上の大きさ（場面1・2・8）: 先頭の1台の全長と、最も小さい足元の印の直径(CSS px)。 */
  bikeSizes: { firstBikeLengthPx: number; markerMinDiameterPx: number; markerScale: number } | null;
  /** 広がり（標本点を囲む長方形）の、覆われていない範囲に対する割合の大きい方。 */
  tightness: number | null;
  /** カメラの方位・俯角(度)・注視点までの距離(m)。 */
  pose: { azimuthDeg: number; elevationDeg: number; distance: number };
  /** 場面2 の始まり・途中・終わり。 */
  phase: ScenePhase | null;
  /** 物差しの建物の各点が、画面に入りカードに覆われていないか。 */
  landmark: { name: string; points: { x: number; y: number; ok: boolean }[] } | null;
  camera: { lat: number; lon: number; heightAboveGround: number };
  /** 目標を満たさなかった項目。 */
  failures: string[];
}

/** いまのカメラで、場面 i の主役の見えている割合を測り、目標と比べる。phase は場面2 の始まり・途中・終わり。 */
export async function measureScene(page: Page, i: number, id: string, viewport: string, phase: ScenePhase | null = null): Promise<VisibilityRow> {
  const r = await page.evaluate(() => window.__MAIN__!.measureVisibility({ buildings: true }));
  if (!r) throw new Error(`場面${i + 1} ${id}: 主役が表示されていない`);
  const goal = VISIBILITY_GOALS[phase ? `${id}@${phase}` : id] ?? {};
  const pose = await page.evaluate(() => window.__MAIN__!.pose());
  const bikeSizes = await page.evaluate(() => {
    const a = window.__AKIHABARA__;
    return a && a.shown > 0 ? { firstBikeLengthPx: a.firstBikeLengthPx, markerMinDiameterPx: a.markerMinDiameterPx, markerScale: a.markerScale } : null;
  });
  let tightness: number | null = null;
  if (r.items?.bbox) {
    const region = await freeRegionOf(page);
    const b = r.items.bbox;
    tightness = Math.max((b.right - b.left) / (region.right - region.left), (b.bottom - b.top) / (region.bottom - region.top));
  }
  const short = Math.min(r.width, r.height);
  const size = r.bbox ? Math.max(r.bbox.right - r.bbox.left, r.bbox.bottom - r.bbox.top) / short : 0;
  let landmark: VisibilityRow['landmark'] = null;
  if (goal.landmark) {
    const pts = await page.evaluate(
      ([points, covers]) =>
        points.map((p) => {
          const g = window.__MAIN__!.groundHeight(p.lat, p.lon);
          const s = window.__MAIN__!.project(p.lat, p.lon, g + p.heightM);
          const w = window.innerWidth;
          const h = window.innerHeight;
          const inView = s.inFront && s.x >= 0 && s.x <= w && s.y >= 0 && s.y <= h;
          const covered = covers.some((c) => s.x >= c.left && s.x <= c.right && s.y >= c.top && s.y <= c.bottom);
          return { x: Math.round(s.x), y: Math.round(s.y), ok: inView && !covered };
        }),
      [goal.landmark.points, r.covers] as const,
    );
    landmark = { name: goal.landmark.name, points: pts };
  }
  const failures: string[] = [];
  if (goal.clear !== undefined && r.clear < goal.clear) failures.push(`clear ${r.clear.toFixed(3)} < ${goal.clear}`);
  if (goal.itemsClear !== undefined && (r.items?.clearFraction ?? 0) < goal.itemsClear)
    failures.push(`台数 ${r.items?.clear ?? 0}/${r.items?.total ?? 0}（${(r.items?.clearFraction ?? 0).toFixed(3)}）< ${goal.itemsClear}`);
  if (goal.unoccluded !== undefined && r.unoccluded < goal.unoccluded) failures.push(`unoccluded ${r.unoccluded.toFixed(3)} < ${goal.unoccluded}`);
  if (goal.onScreen !== undefined && r.onScreen < goal.onScreen) failures.push(`onScreen ${r.onScreen.toFixed(3)} < ${goal.onScreen}`);
  if (goal.sizeOfShortSide !== undefined && size < goal.sizeOfShortSide) failures.push(`size ${size.toFixed(3)} < ${goal.sizeOfShortSide}`);
  if (landmark && !landmark.points.every((p) => p.ok)) failures.push(`${landmark.name} が画面に入っていない、またはカードに覆われている`);
  if (goal.framed !== undefined && (r.items?.framedFraction ?? 0) < goal.framed)
    failures.push(`画面に収まる台数 ${r.items?.framed ?? 0}/${r.items?.total ?? 0} < ${goal.framed}`);
  if (goal.firstBikeMinPx !== undefined && (bikeSizes?.firstBikeLengthPx ?? 0) < goal.firstBikeMinPx)
    failures.push(`先頭の1台の全長 ${(bikeSizes?.firstBikeLengthPx ?? 0).toFixed(1)}px < ${goal.firstBikeMinPx}`);
  if (goal.markerMinPx !== undefined && (bikeSizes?.markerMinDiameterPx ?? 0) < goal.markerMinPx)
    failures.push(`足元の印の直径 ${(bikeSizes?.markerMinDiameterPx ?? 0).toFixed(1)}px < ${goal.markerMinPx}`);
  if (goal.tightness !== undefined && (tightness ?? 0) < goal.tightness)
    failures.push(`広がりが範囲に対して小さい ${(tightness ?? 0).toFixed(3)} < ${goal.tightness}（最も近い距離ではない）`);
  if (goal.maxElevationDeg !== undefined && pose.elevationDeg > goal.maxElevationDeg)
    failures.push(`俯角 ${pose.elevationDeg.toFixed(1)}° > ${goal.maxElevationDeg}°`);
  const cam = await page.evaluate(() => window.__MAIN__!.camera());
  const portrait = await page.evaluate(() => window.__MAIN__!.portrait());
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    scene: i + 1,
    id,
    viewport,
    portrait,
    subjectPixels: r.subjectPixels,
    soloPixels: r.soloPixels,
    onScreen: round(r.onScreen),
    unoccluded: round(r.unoccluded),
    clear: round(r.clear),
    occludedOnScreen: round(r.occludedOnScreen),
    sizeOfShortSide: round(size),
    bbox: r.bbox,
    buildingShare: r.buildingShare === null ? null : round(r.buildingShare),
    items: r.items
      ? {
          total: r.items.total,
          visible: r.items.visible,
          clear: r.items.clear,
          visibleFraction: round(r.items.visibleFraction),
          clearFraction: round(r.items.clearFraction),
          framed: r.items.framed,
          framedFraction: round(r.items.framedFraction),
        }
      : null,
    bikeSizes: bikeSizes && {
      firstBikeLengthPx: round(bikeSizes.firstBikeLengthPx),
      markerMinDiameterPx: round(bikeSizes.markerMinDiameterPx),
      markerScale: round(bikeSizes.markerScale),
    },
    tightness: tightness === null ? null : round(tightness),
    pose: { azimuthDeg: round(pose.azimuthDeg), elevationDeg: round(pose.elevationDeg), distance: Math.round(pose.distance) },
    phase,
    landmark,
    camera: { lat: Number(cam.lat.toFixed(6)), lon: Number(cam.lon.toFixed(6)), heightAboveGround: Math.round(cam.heightAboveGround * 10) / 10 },
    failures,
  };
}
