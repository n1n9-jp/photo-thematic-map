/**
 * 場面2・8 のカメラが使う、秋葉原の 462台の広がり（台本の AKIHABARA_EXTENTS）が、実際の配置と合っているか。
 * あわせて、場面2 の中でカメラが引いていく経由点と、場面1 からの方位の差を確かめる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cityGridFromBytes, type GridMeta } from '../../src/data/grids';
import { latLonToLocal } from '../../src/geo/enu';
import { computeAkihabaraLayout } from '../../src/app/modules/akihabara/layout';
import { GROW_END_OF_HOLD, growCount } from '../../src/app/modules/akihabara/module';
import { AKIHABARA_EXTENTS, AKIHABARA_GROW_END, akihabaraAtCount, SCRIPT } from '../../src/story/content/script';
import { viewFor } from '../../src/story/cameraPath';

const BASE = 'public/data/grids/akihabara';
const meta = JSON.parse(readFileSync(`${BASE}.json`, 'utf8')) as GridMeta;
const grid = cityGridFromBytes(meta, {
  height: readFileSync(`${BASE}.height.bin`),
  ground: readFileSync(`${BASE}.ground.bin`),
  classes: readFileSync(`${BASE}.class.bin`),
});
const layout = computeAkihabaraLayout(grid).layout;

/** 点 (e, n) が凸多角形（反時計回り）の中（境界から tol 以内の外側を含む）にあるか。 */
function insideConvex(hull: readonly (readonly [number, number])[], e: number, n: number, tol: number): boolean {
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i]!;
    const [bx, by] = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const cross = ((bx - ax) * (n - ay) - (by - ay) * (e - ax)) / len;
    if (cross < -tol) return false;
  }
  return true;
}

describe('秋葉原の 462台の広がり（台本）', () => {
  it('先頭 k 台は、それぞれの広がりの多角形の中（境界から外へ 1m 以内を含む）にある', () => {
    for (const ext of Object.values(AKIHABARA_EXTENTS)) {
      const c = latLonToLocal({ ...ext.center, alt: 0 });
      for (let i = 0; i < ext.count; i++) {
        const e = layout.positions[i * 3]! - c.x;
        const n = -(layout.positions[i * 3 + 2]! - c.z);
        expect(insideConvex(ext.hull, e, n, 1), `k=${ext.count} の ${i} 台目 (${e.toFixed(1)}, ${n.toFixed(1)})`).toBe(true);
      }
    }
  });

  it('増えきる進み具合は、場面のモジュールと同じで、経由点の k 台目が現れる位置に置かれている', () => {
    expect(AKIHABARA_GROW_END).toBe(GROW_END_OF_HOLD);
    const hold = 0.5;
    for (const ext of Object.values(AKIHABARA_EXTENTS)) {
      // その経由点に着いたとき、表示中の台数は k 台
      expect(growCount(akihabaraAtCount(ext.count) * hold, hold)).toBe(ext.count);
    }
  });

  it('場面2 のカメラは始まりから終わりへ引いていき、終わりは場面8 と同じ構図', () => {
    const s2 = SCRIPT.find((s) => s.id === 'akihabara-462')!.camera;
    const s8 = SCRIPT.find((s) => s.id === 'since-1990')!.camera;
    const stops = s2.stops ?? [];
    expect(stops.length).toBeGreaterThan(2);
    for (let i = 1; i < stops.length; i++) expect(stops[i]!.at).toBeGreaterThan(stops[i - 1]!.at);
    const last = stops[stops.length - 1]!;
    expect(last.at).toBeCloseTo(AKIHABARA_GROW_END, 9);
    const { portrait: s8portrait, ...s8landscape } = s8;
    expect(last.camera).toEqual(s8landscape);
    expect(last.portrait).toEqual(s8portrait);
  });

  it('場面1 → 場面2 の始まり、場面2 の始まり → 終わりの方位の差は 150° 以内（追いかける途中で回る向きが反転しない）', () => {
    const diff = (a: number, b: number): number => {
      const d = (((b - a) % 360) + 360) % 360;
      return d > 180 ? 360 - d : d;
    };
    const s1 = SCRIPT.find((s) => s.id === 'akihabara-one')!.camera;
    const s2 = SCRIPT.find((s) => s.id === 'akihabara-462')!.camera;
    const end = s2.stops![s2.stops!.length - 1]!;
    for (const portrait of [false, true]) {
      const a1 = viewFor(s1, portrait).azimuthDeg;
      const a2 = viewFor(s2, portrait).azimuthDeg;
      const a3 = (portrait && end.portrait ? end.portrait : end.camera).azimuthDeg;
      expect(diff(a1, a2)).toBeLessThanOrEqual(150);
      expect(diff(a2, a3)).toBeLessThanOrEqual(150);
    }
  });
});
