import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import {
  POINT_MARK_RADIUS,
  CANDIDATES_PER_ANCHOR,
  CONE_STEPS,
  LEADER_LENGTHS,
  isLeaderCandidate,
  SCOPE_MIN_M,
  SCOPE_PER_DISTANCE,
  inScope,
  keepOutRects,
  layoutPlaceLabels,
  placeCandidates,
  tierVisibleAt,
  type PlaceLabelRequest,
  type Rect,
} from '../../src/scene/placeLabels';
import { PLACE_NAMES, PLACE_TIER_HEIGHTS, SCENE_PLACE_NAMES, placesForScene, type PlaceId } from '../../src/story/content/placeNames';
import { SCRIPT } from '../../src/story/content/script';

const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const BOUNDS: Rect = { x: 0, y: 0, w: 800, h: 600 };
const req = (id: string, ax: number, ay: number, kind: PlaceLabelRequest['kind'] = 'area', w = 60, h = 16): PlaceLabelRequest => ({
  id,
  kind,
  ax,
  ay,
  w,
  h,
});

describe('地名の段階（カメラの高さ）', () => {
  it('俯瞰では区や大きな目印、寄ると近くの地名', () => {
    // 23区の俯瞰（高さ約 28km）
    expect(tierVisibleAt('region', 28_000)).toBe(true);
    expect(tierVisibleAt('district', 28_000)).toBe(false);
    expect(tierVisibleAt('local', 28_000)).toBe(false);
    // 秋葉原の上空（高さ約 500m）
    expect(tierVisibleAt('region', 500)).toBe(false);
    expect(tierVisibleAt('district', 500)).toBe(true);
    expect(tierVisibleAt('local', 500)).toBe(true);
    // 駅前の1台に寄った高さ（約 14m）では、地区の名前も出さない
    expect(tierVisibleAt('district', 14)).toBe(false);
    expect(tierVisibleAt('local', 14)).toBe(true);
  });

  it('段階の範囲は、下限を含み上限を含まない', () => {
    for (const [tier, r] of Object.entries(PLACE_TIER_HEIGHTS) as [keyof typeof PLACE_TIER_HEIGHTS, { min: number; max: number }][]) {
      expect(tierVisibleAt(tier, r.min)).toBe(true);
      if (Number.isFinite(r.max)) expect(tierVisibleAt(tier, r.max)).toBe(false);
    }
  });

  it('注視点から、カメラの距離の SCOPE_PER_DISTANCE 倍（下限 SCOPE_MIN_M）より遠い地名は出さない', () => {
    const target = { x: 0, z: 0 };
    expect(inScope({ x: 399, z: 0 }, target, 100)).toBe(true);
    expect(inScope({ x: 100 * SCOPE_PER_DISTANCE + 1, z: 0 }, target, 100)).toBe(false);
    // 地上の目線（注視点まで 6m）でも、SCOPE_MIN_M までは出す
    expect(inScope({ x: SCOPE_MIN_M - 1, z: 0 }, target, 6)).toBe(true);
    expect(inScope({ x: SCOPE_MIN_M + 1, z: 0 }, target, 6)).toBe(false);
    expect(inScope({ x: 3000, z: 4000 }, target, 32_000)).toBe(true);
  });
});

describe('地名の配置（layoutPlaceLabels）', () => {
  it('広がりの名前は、空いていれば地点を中心に置く', () => {
    const [p] = layoutPlaceLabels([req('a', 400, 300)], BOUNDS);
    expect(p!.x + p!.w / 2).toBeCloseTo(400);
    expect(p!.y + p!.h / 2).toBeCloseTo(300);
    expect(p!.candidate).toBe(0);
  });

  it('駅・建物の名前は、印の右に置き、印に重ねない', () => {
    const [p] = layoutPlaceLabels([req('s', 400, 300, 'point')], BOUNDS);
    expect(p!.x).toBeGreaterThan(400 + POINT_MARK_RADIUS);
    expect(p!.y + p!.h / 2).toBeCloseTo(300);
  });

  it('互いに重ならない。先頭ほど優先され、置けない地名は出さない', () => {
    const many = Array.from({ length: 12 }, (_, i) => req(`p${i}`, 400 + (i % 3) * 4, 300 + Math.floor(i / 3) * 3));
    const placed = layoutPlaceLabels(many, BOUNDS);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(many.length);
    expect(placed[0]!.id).toBe('p0');
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!)).toBe(false);
    }
  });

  it('地点から遠くへはずらさない（文字の高さの 1.6 倍まで）', () => {
    const r = req('a', 400, 300);
    for (const [x, y] of placeCandidates(r)) {
      expect(Math.abs(y + r.h / 2 - r.ay)).toBeLessThanOrEqual(r.h * 1.6 + 1e-9);
      expect(Math.abs(x + r.w / 2 - r.ax)).toBeLessThanOrEqual(r.w * 0.3 + 1e-9);
    }
  });

  it('障害物（本文カード・凡例・主役）と、範囲の外には置かない', () => {
    const card: Rect = { x: 360, y: 280, w: 80, h: 40 };
    const placed = layoutPlaceLabels([req('a', 400, 300), req('b', 790, 300)], BOUNDS, [card]);
    for (const p of placed) {
      expect(overlap(p, card)).toBe(false);
      expect(p.x).toBeGreaterThanOrEqual(BOUNDS.x);
      expect(p.x + p.w).toBeLessThanOrEqual(BOUNDS.x + BOUNDS.w);
    }
  });

  it('ほかの地名の印に重ねない', () => {
    const placed = layoutPlaceLabels([req('area', 400, 300, 'area', 80, 16), req('pt', 400, 300, 'point', 40, 14)], BOUNDS);
    const mark: Rect = { x: 400 - POINT_MARK_RADIUS, y: 300 - POINT_MARK_RADIUS, w: POINT_MARK_RADIUS * 2, h: POINT_MARK_RADIUS * 2 };
    for (const p of placed) expect(overlap(p, mark)).toBe(false);
  });

  it('駅・建物の名前は、周りが埋まっていれば真上へ離して引き出し線を引く。線も障害物に重ねない', () => {
    // 印の左右と下を塞ぐ（印の真上の細い道と、24px より上は空いている）
    const around: Rect[] = [
      { x: 330, y: 280, w: 66, h: 40 },
      { x: 404, y: 280, w: 66, h: 40 },
      { x: 330, y: 304, w: 140, h: 20 },
    ];
    const [p] = layoutPlaceLabels([req('s', 400, 300, 'point', 60, 16)], BOUNDS, around);
    expect(p!.leader).toBe(true);
    expect(isLeaderCandidate('point', p!.candidate % CANDIDATES_PER_ANCHOR)).toBe(true);
    expect(p!.y + p!.h).toBeLessThanOrEqual(300 - LEADER_LENGTHS[0]);
    expect(p!.x).toBeLessThanOrEqual(400);
    expect(p!.x + p!.w).toBeGreaterThanOrEqual(400);
    // 線の通り道（印の真上）を塞ぐと、離して置く候補は使えない
    const column: Rect = { x: 398, y: 200, w: 4, h: 80 };
    expect(layoutPlaceLabels([req('s', 400, 300, 'point', 60, 16)], BOUNDS, [...around, column])).toEqual([]);
  });

  it('印が主役に掛かる地点は使わず、ほかの候補の地点に置く', () => {
    const pile: Rect = { x: 380, y: 280, w: 40, h: 40 };
    const [p] = layoutPlaceLabels([{ ...req('s', 400, 300, 'point'), alternatives: [{ ax: 600, ay: 300 }] }], BOUNDS, [pile]);
    expect(p!.anchor).toBe(1);
    expect(p!.ax).toBe(600);
  });

  it('前回の位置が空いていれば、そのまま使う（カメラが少し動いても位置を変えない）', () => {
    const first = layoutPlaceLabels([req('a', 400, 300)], BOUNDS, [{ x: 360, y: 290, w: 80, h: 20 }])[0]!;
    expect(first.candidate).not.toBe(0);
    const again = layoutPlaceLabels([{ ...req('a', 401, 300), previous: first.candidate }], BOUNDS)[0]!;
    expect(again.candidate).toBe(first.candidate);
  });
});

describe('主役を画面に投影した矩形（keepOutRects）', () => {
  const camera = new PerspectiveCamera(45, 800 / 600, 1, 10_000);
  camera.position.set(0, 100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  it('真下の点は画面の中央。カメラの後ろの点は数えない', () => {
    const rects = keepOutRects({ points: { positions: [0, 0, 0, 0, 200, 0], radiusM: 1, minPx: 3 } }, camera, 800, 600);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x + rects[0]!.w / 2).toBeCloseTo(400, 0);
    expect(rects[0]!.y + rects[0]!.h / 2).toBeCloseTo(300, 0);
    // 100m 先の半径 1m は、焦点距離 300/tan(22.5°) ≈ 724px で約 7px
    expect(rects[0]!.w / 2).toBeCloseTo(724.26 / 100, 1);
  });

  it('柱は底から頂点まで、箱は 8 隅を囲む', () => {
    const [seg] = keepOutRects({ segments: { positions: [0, 0, 0, 10, 0, 0], padPx: 3 } }, camera, 800, 600);
    expect(seg!.w).toBeGreaterThan(70);
    expect(seg!.h).toBeCloseTo(6, 3);
    const [box] = keepOutRects({ boxes: [{ min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 20, z: 10 } }] }, camera, 800, 600);
    expect(box!.x).toBeLessThan(400);
    expect(box!.x + box!.w).toBeGreaterThan(400);
  });
});

describe('場面ごとの地名（content/placeNames.ts）', () => {
  it('台本のすべての場面に地名の一覧があり、一覧の地名はすべて定義されている', () => {
    for (const s of SCRIPT) {
      const ids = SCENE_PLACE_NAMES[s.id];
      expect(ids, s.id).toBeDefined();
      expect(ids!.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids!.length);
      for (const id of ids!) expect(PLACE_NAMES[id as PlaceId], id).toBeDefined();
    }
  });

  it('座標は23区の範囲（東京湾の北部を含む）に入る', () => {
    for (const [id, p] of Object.entries(PLACE_NAMES)) {
      expect(p.lat, id).toBeGreaterThan(35.5);
      expect(p.lat, id).toBeLessThan(35.82);
      expect(p.lon, id).toBeGreaterThan(139.56);
      expect(p.lon, id).toBeLessThan(139.92);
    }
  });

  it('俯瞰の場面（3・4）は同じ地名を出す（場面の間で消さない）', () => {
    expect(SCENE_PLACE_NAMES['tokyo-13394']).toBe(SCENE_PLACE_NAMES['parking-vacancy']);
    expect(placesForScene('tokyo-13394').every((p) => p.tier === 'region')).toBe(true);
  });

  it('寄った場面の地名は、場面の注視点から 2km 以内', () => {
    for (const s of SCRIPT) {
      if (!s.place) continue;
      for (const p of placesForScene(s.id)) {
        const dy = (p.lat - s.place.lat) * 111_000;
        const dx = (p.lon - s.place.lon) * 111_000 * Math.cos((p.lat * Math.PI) / 180);
        expect(Math.hypot(dx, dy), `${s.id} ${p.name}`).toBeLessThan(2000);
      }
    }
  });
});

describe('山を囲む円錐（keepOutRects の cones）', () => {
  it('段ごとの矩形は上ほど狭く、頂上の横は空く', () => {
    const camera = new PerspectiveCamera(45, 800 / 600, 1, 10_000);
    camera.position.set(0, 30, 300);
    camera.lookAt(0, 30, 0);
    camera.updateMatrixWorld();
    const rects = keepOutRects({ cones: [{ base: { x: 0, y: 0, z: 0 }, radiusM: 50, heightM: 40 }] }, camera, 800, 600);
    expect(rects).toHaveLength(CONE_STEPS);
    for (let k = 1; k < rects.length; k++) expect(rects[k]!.w).toBeLessThan(rects[k - 1]!.w);
    // 頂上の高さの、裾の端の真上の点は、どの矩形にも入らない
    const top = rects[rects.length - 1]!;
    const beside = { x: rects[0]!.x + 2, y: top.y + 1, w: 1, h: 1 };
    expect(rects.some((r) => overlap(r, beside))).toBe(false);
  });
});
