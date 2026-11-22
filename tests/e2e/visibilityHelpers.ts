/**
 * 本編の主役（自転車・自転車の山）の「見えている割合」を測り、目標と比べる（main.spec.ts から使う）。
 *
 * 割合は `window.__MAIN__.measureVisibility()`（src/app/visibility.ts）が、画面外の描画先へ描いて画素を数えて求める。
 * - unoccluded: 主役の画素のうち、建物にも地面にも隠れず画面に入っている割合（画面の外の分も「見えていない」に数える）。
 * - clear: さらに本文カードと出典表示にも覆われていない割合。
 * - items（場面2・8 の 462台）: 1台ごとの標本点（3 点）で数えた、建物にも本文カードにも隠れずに見えている台数の割合。
 *   遠くから見下ろす場面では自転車が 1 台 1 画素に満たず、画素の比はカメラのわずかな違いで揺れるので、目標は台数で確かめる。
 * 物差しの建物（丸の内駅舎・都庁第一本庁舎）は、上端と足元の点が画面に入り、カードに覆われていないかで確かめる。
 */
import type { Page } from '@playwright/test';
import { PLACES } from '../../src/story/content/script';

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
}

/** 場面 id → 目標。 */
export const VISIBILITY_GOALS: Record<string, VisibilityGoal> = {
  'akihabara-one': { unoccluded: 0.95, clear: 0.95, sizeOfShortSide: 0.2 },
  'akihabara-462': { itemsClear: 0.8 },
  'removed-fy2024': { unoccluded: 0.9, onScreen: 0.98, landmark: MARUNOUCHI },
  'removed-15years': { unoccluded: 0.9, onScreen: 0.98, landmark: TOCHO },
  'after-removal': { unoccluded: 0.9, onScreen: 0.98, landmark: MARUNOUCHI },
  'since-1990': { itemsClear: 0.8 },
};

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
  items: { total: number; visible: number; clear: number; visibleFraction: number; clearFraction: number } | null;
  /** 物差しの建物の各点が、画面に入りカードに覆われていないか。 */
  landmark: { name: string; points: { x: number; y: number; ok: boolean }[] } | null;
  camera: { lat: number; lon: number; heightAboveGround: number };
  /** 目標を満たさなかった項目。 */
  failures: string[];
}

/** いまのカメラで、場面 i の主役の見えている割合を測り、目標と比べる。 */
export async function measureScene(page: Page, i: number, id: string, viewport: string): Promise<VisibilityRow> {
  const r = await page.evaluate(() => window.__MAIN__!.measureVisibility({ buildings: true }));
  if (!r) throw new Error(`場面${i + 1} ${id}: 主役が表示されていない`);
  const goal = VISIBILITY_GOALS[id] ?? {};
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
    items: r.items ? { ...r.items, visibleFraction: round(r.items.visibleFraction), clearFraction: round(r.items.clearFraction) } : null,
    landmark,
    camera: { lat: Number(cam.lat.toFixed(6)), lon: Number(cam.lon.toFixed(6)), heightAboveGround: Math.round(cam.heightAboveGround * 10) / 10 },
    failures,
  };
}
