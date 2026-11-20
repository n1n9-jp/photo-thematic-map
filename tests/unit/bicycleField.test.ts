import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { BicycleField, lodSwitchDistances, selectLod } from '../../src/scene/bicycle/field';
import { concatInstances, heapOnSurface, moundHeight, parkedRows, singleBicycle } from '../../src/scene/bicycle/layouts';

describe('詳細度の切り替え距離', () => {
  it('全長が閾値ピクセルになる距離を返す', () => {
    // fov 90° なら焦点距離 f = H/2。全長 1.8m が 90px → 距離 = 1.8 * 360 / 90 = 7.2m
    const [near, mid] = lodSwitchDistances(90, 720, [90, 18]);
    expect(near).toBeCloseTo(7.2, 6);
    expect(mid).toBeCloseTo(36, 6);
  });
  it('距離に応じて 0/1/2 を選ぶ', () => {
    expect(selectLod(5, [10, 50])).toBe(0);
    expect(selectLod(10, [10, 50])).toBe(1);
    expect(selectLod(80, [10, 50])).toBe(2);
  });
});

describe('BicycleField', () => {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 3000);

  it('カメラ距離で詳細度を振り分け、姿勢データの差し替えで更新される', () => {
    const field = new BicycleField();
    field.setInstances(concatInstances(singleBicycle({ x: 0, y: 0, z: 0 }, 0, 0xffffff), singleBicycle({ x: 0, y: 0, z: -500 }, 0, 0)));
    camera.position.set(0, 1.5, 4);
    camera.lookAt(0, 0.5, 0);
    camera.updateMatrixWorld();
    field.update(camera, 720);
    expect(field.stats.perLod).toEqual([1, 0, 1]);
    expect(field.stats.triangles).toBe(field.stats.trianglesPerInstance[0] + field.stats.trianglesPerInstance[2]);

    // 視錐台の外（カメラの後ろ）は描かない
    field.setInstances(singleBicycle({ x: 0, y: 0, z: 50 }, 0, 0));
    field.update(camera, 720);
    expect(field.stats.visible).toBe(0);
    expect(field.stats.total).toBe(1);
  });

  it('近景の台数上限を超えた分は一段粗くする', () => {
    const field = new BicycleField({ maxInstancesPerLod: [10, 1000], cellSize: 1 });
    field.setInstances(parkedRows({ seed: 3, count: 200, start: { x: -60, z: 0 } }));
    camera.position.set(0, 3, 6);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    field.update(camera, 720);
    expect(field.stats.perLod[0]).toBeLessThanOrEqual(10);
    expect(field.stats.perLod[0]).toBeGreaterThan(0);
    expect(field.stats.perLod[1]).toBeGreaterThan(0);
  });

  it('lodFloor=3 の自転車は描かず、2 は常に遠景で描く', () => {
    const field = new BicycleField();
    const data = concatInstances(singleBicycle({ x: 0, y: 0, z: 0 }, 0, 0), singleBicycle({ x: 3, y: 0, z: 0 }, 0, 0));
    data.lodFloor![0] = 3;
    data.lodFloor![1] = 2;
    field.setInstances(data);
    camera.position.set(1.5, 1.5, 4);
    camera.lookAt(1.5, 0.5, 0);
    camera.updateMatrixWorld();
    field.update(camera, 720);
    expect(field.stats.perLod).toEqual([0, 0, 1]);
  });
});

describe('配置', () => {
  const heapOpts = {
    seed: 7,
    count: 3000,
    height: moundHeight({ x: 0, z: 0 }, 12, 6),
    bounds: { minX: -12, maxX: 12, minZ: -12, maxZ: 12 },
  };

  it('同じ種なら同じ結果、違う種なら違う結果', () => {
    const a = heapOnSurface(heapOpts);
    const b = heapOnSurface(heapOpts);
    const c = heapOnSurface({ ...heapOpts, seed: 8 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
    const p1 = parkedRows({ seed: 1, count: 50, start: { x: 0, z: 0 } });
    const p2 = parkedRows({ seed: 1, count: 50, start: { x: 0, z: 0 } });
    expect(Array.from(p1.quaternions)).toEqual(Array.from(p2.quaternions));
  });

  it('山積みは高さ関数の内側に収まり、四元数は単位長', () => {
    const a = heapOnSurface(heapOpts);
    const h = heapOpts.height;
    for (let i = 0; i < a.count; i++) {
      const x = a.positions[i * 3]!;
      const y = a.positions[i * 3 + 1]!;
      const z = a.positions[i * 3 + 2]!;
      expect(Math.hypot(x, z)).toBeLessThan(14);
      expect(y).toBeLessThan(h(x, z) + 2);
      const q = a.quaternions.subarray(i * 4, i * 4 + 4);
      expect(Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!)).toBeCloseTo(1, 5);
    }
  });

  it('容量を超える台数でも指定した台数ぶん配置する', () => {
    const a = heapOnSurface({ ...heapOpts, count: 20000 });
    expect(a.count).toBe(20000);
    // 末尾の要素も埋まっている（原点のままではない）
    const last = a.positions.subarray((a.count - 1) * 3);
    expect(Math.abs(last[0]!) + Math.abs(last[2]!)).toBeGreaterThan(0);
  });

  it('駐輪の列は隣どうしの間隔がほぼ指定どおりで、ほぼ直立している', () => {
    const p = parkedRows({ seed: 2, count: 40, start: { x: 0, z: 0 }, spacing: 0.6 });
    const xs = Array.from({ length: p.count }, (_, i) => p.positions[i * 3]!);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
    expect(mean).toBeGreaterThan(0.5);
    expect(mean).toBeLessThan(0.75);
    for (let i = 0; i < p.count; i++) expect(p.positions[i * 3 + 1]).toBe(0);
  });
});
