/**
 * 秋葉原駅の周りの 462台の配置を、実際の街の高さ格子 `akihabara` で確かめる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cityGridFromBytes, GRID_CLASS, type GridMeta } from '../../src/data/grids';
import { latLonToLocal } from '../../src/geo/enu';
import {
  AKIHABARA_COUNT,
  AKIHABARA_START,
  AKIHABARA_STATION,
  computeAkihabaraLayout,
  blockedMask,
} from '../../src/app/modules/akihabara/layout';
import { growCount } from '../../src/app/modules/akihabara/module';
import { FACTS } from '../../src/story/content/facts';
import { PLACES, SCRIPT } from '../../src/story/content/script';
import { createHeightGrid } from '../../src/sim/heightGrid';
import { layoutStation, prepareStreetMap, orientedRectsOverlap } from '../../src/sim/stationLayout';

const BASE = 'public/data/grids/akihabara';
const meta = JSON.parse(readFileSync(`${BASE}.json`, 'utf8')) as GridMeta;
const grid = cityGridFromBytes(meta, {
  height: readFileSync(`${BASE}.height.bin`),
  ground: readFileSync(`${BASE}.ground.bin`),
  classes: readFileSync(`${BASE}.class.bin`),
});
const res = computeAkihabaraLayout(grid);
const l = res.layout;
const g = grid.ground;
const rails = blockedMask(grid);

function cellIndex(x: number, z: number): number {
  const c = Math.floor((x - g.originX) / g.cellSize);
  const r = Math.floor((z - g.originZ) / g.cellSize);
  if (c < 0 || r < 0 || c >= g.width || r >= g.height) return -1;
  return r * g.width + c;
}

/** 自転車 i の足元の点（長さ方向 5点 × 幅方向 3点）。 */
function footprint(i: number): Array<[number, number]> {
  const x = l.positions[i * 3]!;
  const z = l.positions[i * 3 + 2]!;
  const ux = Math.cos(l.yaws[i]!);
  const uz = -Math.sin(l.yaws[i]!);
  const hw = l.widths[i]! / 2;
  const pts: Array<[number, number]> = [];
  for (const a of [-1, -0.5, 0, 0.5, 1]) {
    for (const b of [-1, 0, 1]) pts.push([x + ux * a * 0.88 - uz * b * hw, z + uz * a * 0.88 + ux * b * hw]);
  }
  return pts;
}

describe('秋葉原の配置（実際の格子）', () => {
  it('台数は統計の 462台と1台の過不足もなく一致する', () => {
    expect(AKIHABARA_COUNT).toBe(FACTS.akihabaraParked.value);
    expect(l.count).toBe(462);
    expect(res.onGround + res.underBridge).toBe(462);
    for (let i = 0; i < l.positions.length; i++) expect(Number.isFinite(l.positions[i]!)).toBe(true);
  });

  it('建物・水面・線路・首都高・川の上の橋のセルに置かない（足元のすべての点が地面か高架の下）', () => {
    for (let i = 0; i < l.count; i++) {
      for (const [x, z] of footprint(i)) {
        const k = cellIndex(x, z);
        expect(k, `${i}`).toBeGreaterThanOrEqual(0);
        const cls = grid.classes[k]!;
        expect(cls === GRID_CLASS.ground || cls === GRID_CLASS.bridge, `${i} の足元の分類 ${cls}`).toBe(true);
        expect(rails[k], `${i} が置かない帯の上`).toBe(0);
      }
    }
  });

  it('自転車の高さは地面（建物・高架を除いた地面の格子）の高さ', () => {
    for (let i = 0; i < l.count; i++) {
      const k = cellIndex(l.positions[i * 3]!, l.positions[i * 3 + 2]!);
      expect(l.positions[i * 3 + 1]).toBeCloseTo(g.data[k]!, 4);
    }
  });

  it('自転車どうしが重ならない', () => {
    for (let i = 0; i < l.count; i++) {
      for (let j = i + 1; j < l.count; j++) {
        const xi = l.positions[i * 3]!;
        const zi = l.positions[i * 3 + 2]!;
        const xj = l.positions[j * 3]!;
        const zj = l.positions[j * 3 + 2]!;
        if (Math.hypot(xi - xj, zi - zj) > 2.2) continue;
        const overlap = orientedRectsOverlap(xi, zi, l.yaws[i]!, 0.9, l.widths[i]! / 2 - 1e-3, xj, zj, l.yaws[j]!, 0.9, l.widths[j]! / 2 - 1e-3);
        expect(overlap, `${i} と ${j}`).toBe(false);
      }
    }
  });

  it('駅から 500m 以内に収まる', () => {
    const s = latLonToLocal(AKIHABARA_STATION);
    for (let i = 0; i < l.count; i++) {
      const d = Math.hypot(l.positions[i * 3]! - s.x, l.positions[i * 3 + 2]! - s.z);
      expect(d + l.bikeLength / 2).toBeLessThanOrEqual(500);
    }
    expect(res.maxDistanceM).toBeLessThanOrEqual(500);
  });

  it('先頭の1台は電気街口の駅前広場の最寄りの壁際（場面1・8 の注視点）にあり、外側へ広がる', () => {
    const f = latLonToLocal(AKIHABARA_START);
    const d0 = Math.hypot(l.positions[0]! - f.x, l.positions[2]! - f.z);
    expect(d0).toBeLessThan(20);
    // 台本の注視点（PLACES.akihabaraFirstBike）と 0.5m 以内で一致する
    const fb = latLonToLocal(PLACES.akihabaraFirstBike);
    expect(Math.hypot(l.positions[0]! - fb.x, l.positions[2]! - fb.z)).toBeLessThan(0.5);
    // 場面1 のカメラ（方位 40°）から横向き: 自転車の向き（東西）とカメラの視線の角度が 90° ± 45° 以内
    const cam = SCRIPT[0]!.camera;
    const view = (cam.azimuthDeg * Math.PI) / 180;
    const vx = Math.sin(view);
    const vz = -Math.cos(view);
    const bx = Math.cos(l.yaws[0]!);
    const bz = -Math.sin(l.yaws[0]!);
    expect(Math.abs(vx * bx + vz * bz)).toBeLessThan(Math.cos(Math.PI / 4));
    // 前半の平均距離 < 後半の平均距離
    const dist = (i: number): number => Math.hypot(l.positions[i * 3]! - f.x, l.positions[i * 3 + 2]! - f.z);
    let near = 0;
    let far = 0;
    for (let i = 0; i < 231; i++) near += dist(i);
    for (let i = 231; i < 462; i++) far += dist(i);
    expect(near).toBeLessThan(far);
  });

  it('駅前から通りへあふれるように広がる（最も遠い自転車は置き始めから 100m 以上）', () => {
    expect(res.maxFromStartM).toBeGreaterThan(100);
  });
});

describe('prepareStreetMap（分類を渡したとき）', () => {
  it('地面と高架の下を路上、建物と水面を置けない場所にする', () => {
    const gr = createHeightGrid(30, 30, 1, 0, 0);
    const classes = new Uint8Array(900);
    for (let r = 0; r < 30; r++) {
      for (let c = 0; c < 30; c++) {
        if (c < 5) classes[r * 30 + c] = GRID_CLASS.building;
        else if (c >= 25) classes[r * 30 + c] = GRID_CLASS.nodata;
        else if (c >= 12 && c < 18) classes[r * 30 + c] = GRID_CLASS.bridge;
      }
    }
    const map = prepareStreetMap(gr, { classes });
    for (let r = 0; r < 30; r++) {
      for (let c = 0; c < 30; c++) {
        const k = classes[r * 30 + c]!;
        expect(map.street[r * 30 + c]).toBe(k === GRID_CLASS.ground || k === GRID_CLASS.bridge ? 1 : 0);
      }
    }
    // 建物の壁際に置ける
    const lay = layoutStation(map, { x: 10, z: 15 }, 20, 1, { radius: 40, centerClearance: 0.5 });
    expect(lay.count).toBe(20);
  });

  it('blocked のセルには置かない', () => {
    const gr = createHeightGrid(30, 30, 1, 0, 0);
    const blocked = new Uint8Array(900);
    for (let r = 0; r < 30; r++) for (let c = 10; c < 14; c++) blocked[r * 30 + c] = 1;
    const map = prepareStreetMap(gr, { classes: new Uint8Array(900), blocked });
    for (let r = 0; r < 30; r++) for (let c = 10; c < 14; c++) expect(map.street[r * 30 + c]).toBe(0);
  });
});

describe('場面2 の台数の増え方', () => {
  it('進み具合 0 で 1台、カメラが止まっている区間の 85% で 462台', () => {
    expect(growCount(0, 0.4)).toBe(1);
    expect(growCount(0.4 * 0.85, 0.4)).toBe(462);
    expect(growCount(1, 0.4)).toBe(462);
    const mid = growCount(0.17, 0.4);
    expect(mid).toBeGreaterThan(200);
    expect(mid).toBeLessThan(260);
    // 単調
    let prev = 0;
    for (let p = 0; p <= 1; p += 0.01) {
      const n = growCount(p, 0.4);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});
