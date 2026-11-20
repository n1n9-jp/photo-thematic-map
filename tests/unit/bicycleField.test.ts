import { Frustum, InstancedBufferGeometry, Matrix4, Mesh, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  BicycleField,
  bicycleBoundingRadius,
  lodSwitchDistances,
  maxVertexDistance,
  selectLod,
  selectLodWithHysteresis,
} from '../../src/scene/bicycle/field';
import { createBicycleGeometry } from '../../src/scene/bicycle/geometry';
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
  it('余裕幅の中では直前の詳細度を保つ', () => {
    const sw: [number, number] = [10, 50];
    expect(selectLodWithHysteresis(10.5, sw, 0, 0.15)).toBe(0); // 近景のまま
    expect(selectLodWithHysteresis(10.5, sw, 1, 0.15)).toBe(1); // 中景のまま
    expect(selectLodWithHysteresis(9, sw, 1, 0.15)).toBe(1); // 8.5m を下回るまで細かくしない
    expect(selectLodWithHysteresis(8.4, sw, 1, 0.15)).toBe(0);
    expect(selectLodWithHysteresis(11.6, sw, 0, 0.15)).toBe(1); // 11.5m を超えたら粗くする
    expect(selectLodWithHysteresis(200, sw, 0, 0.15)).toBe(2);
    expect(selectLodWithHysteresis(10.5, sw, -1, 0.15)).toBe(1); // 未定なら余裕幅なし
  });
});

/** 平面と境界球の判定（視錐台の中か）を BicycleField と独立に行う。 */
function frustumOf(camera: PerspectiveCamera): Frustum {
  camera.updateMatrixWorld();
  return new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}

const pileOpts = {
  seed: 11,
  count: 20000,
  height: moundHeight({ x: 0, z: 0 }, 22, 10),
  bounds: { minX: -22, maxX: 22, minZ: -22, maxZ: 22 },
};

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

describe('BicycleField: 視錐台の判定の半径', () => {
  it('どの詳細度の頂点も、原点から判定用の半径以内にある', () => {
    const r = bicycleBoundingRadius();
    for (const lod of [0, 1, 2] as const) {
      const geo = createBicycleGeometry(lod);
      expect(maxVertexDistance(geo)).toBeLessThan(r);
      geo.dispose();
    }
  });

  it('中心が視錐台の外でも、形状の一部が入っていれば描く', () => {
    // 原点から最も遠い頂点の向きにカメラを置き、その頂点だけが遠方面の内側に入る位置に自転車を置く
    let vmax = new Vector3();
    for (const lod of [0, 1, 2] as const) {
      const geo = createBicycleGeometry(lod);
      const p = geo.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const v = new Vector3(p.getX(i), p.getY(i), p.getZ(i));
        if (v.length() > vmax.length()) vmax = v;
      }
      geo.dispose();
    }
    const len = vmax.length();
    expect(len).toBeGreaterThan(1.1);
    const dir = vmax.clone().normalize(); // 視線は -dir
    const far = 50;
    const s = (1.0 + len) / 2; // 中心は遠方面の外 s m、頂点は内側 len - s m
    const P = new Vector3(5, 0, -3);
    const cam = new PerspectiveCamera(50, 16 / 9, 0.1, far);
    cam.position.copy(P).addScaledVector(dir, far + s);
    cam.lookAt(P.clone().addScaledVector(dir, far + s - 1));
    const field = new BicycleField({ cellSize: 0.01 });
    field.setInstances(singleBicycle(P, 0, 0));
    field.update(cam, 720);
    expect(field.stats.visible).toBe(1);
  });
});

describe('BicycleField: 表示する台数', () => {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 3000);

  it('先頭の n 台だけを表示し、バッファを作り直さない', () => {
    const field = new BicycleField();
    const pile = field.addGroup(heapOnSurface(pileOpts));
    const row = field.addGroup(parkedRows({ seed: 2, count: 300, start: { x: -40, z: 30 } }));
    camera.position.set(60, 40, 90);
    camera.lookAt(0, 0, 0);
    field.update(camera, 720);
    expect(field.stats.total).toBe(20300);
    expect(field.stats.revealed).toBe(20300);
    expect(field.stats.groups).toBe(2);
    const rebuilds = field.stats.rebuilds;
    const full = field.stats.visible;
    expect(full).toBeGreaterThan(0);

    const t0 = performance.now();
    field.setRevealCount(0, pile);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5);
    field.update(camera, 720);
    expect(field.stats.revealed).toBe(300);
    expect(field.stats.rebuilds).toBe(rebuilds);
    // 転送は表示台数のテクスチャ（まとまりごと4バイト）だけ
    expect(field.stats.frameUploadBytes).toBeLessThanOrEqual(64);

    const visibleAt = (n: number): number => {
      field.setRevealCount(n, pile);
      field.update(camera, 720);
      return field.stats.visible;
    };
    const seq = [0, 1, 1000, 5000, 12000, 20000].map(visibleAt);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]!);
    expect(seq[seq.length - 1]).toBe(full);
    expect(field.stats.rebuilds).toBe(rebuilds);

    // 表示中の台数はセルごとの「順位が n 未満の台数」の合計
    field.setRevealCount(777, pile);
    field.setRevealCount(10, row);
    field.update(camera, 720);
    const cells = field.debugCells();
    expect(cells.reduce((a, c) => a + c.revealed, 0)).toBe(787);
    expect(field.stats.revealed).toBe(787);
    expect(field.getRevealCount(pile)).toBe(777);

    // まとめて指定（まとまりの台数で頭打ち）
    field.setRevealCount(1_000_000);
    field.update(camera, 720);
    expect(field.stats.revealed).toBe(20300);
  });

  it('シェーダーに渡す順位とまとまりの番号が登録順と一致する', () => {
    const field = new BicycleField();
    field.forceLod = 2;
    const a = field.addGroup(parkedRows({ seed: 1, count: 30, start: { x: 0, z: 0 } }));
    field.addGroup(parkedRows({ seed: 1, count: 20, start: { x: 0, z: 4 } }));
    camera.position.set(10, 8, 30);
    camera.lookAt(10, 0, 0);
    field.update(camera, 720);
    const seen = new Map<number, number[]>();
    field.object.traverse((o) => {
      if (!(o instanceof Mesh) || !o.visible || !(o.geometry instanceof InstancedBufferGeometry)) return;
      const meta = o.geometry.getAttribute('iMeta');
      for (let i = 0; i < o.geometry.instanceCount; i++) {
        const g = meta.getY(i);
        if (!seen.has(g)) seen.set(g, []);
        seen.get(g)!.push(meta.getX(i));
      }
    });
    expect([...seen.keys()].sort()).toEqual([0, 1]);
    expect(seen.get(a)!.slice().sort((x, y) => x - y)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(seen.get(1)!.length).toBe(20);
  });
});

describe('BicycleField: 転送量と表示台数', () => {
  it('静止したカメラでは転送せず、ゆっくり動くカメラでも遠景の層は送り直さない', () => {
    const field = new BicycleField();
    field.setInstances(heapOnSurface(pileOpts));
    const camera = new PerspectiveCamera(50, 390 / 844, 0.1, 3000);
    const at = (t: number): void => {
      const a = t * 0.004; // 1フレームあたり約 0.12m（半径 30m の円周上）
      camera.position.set(30 * Math.cos(a), 6, 30 * Math.sin(a));
      camera.lookAt(0, 4, 0);
      field.update(camera, 844);
    };
    at(0);
    const initial = field.stats.frameUploadBytes;
    expect(initial).toBeGreaterThan(20000 * 40);
    for (let i = 0; i < 10; i++) {
      at(0);
      expect(field.stats.frameUploadBytes).toBe(0);
    }
    // 近景・中景の容量（上限 + 余裕）ぶんより多くは1フレームで送らない
    const perFrameLimit = (2500 + 20000) * 2 * 44 + 64 * 1024;
    let total = 0;
    let frames = 0;
    for (let t = 1; t <= 300; t++) {
      at(t);
      expect(field.stats.frameUploadBytes).toBeLessThan(perFrameLimit);
      total += field.stats.frameUploadBytes;
      frames++;
    }
    const avg = total / frames;
    console.info(`ゆっくり動くカメラ: 平均 ${Math.round(avg)} B/フレーム、作り直し ${field.stats.rebuilds} 回`);
    // 全台（約 0.9MB）を毎フレーム送り直していた修正前より十分小さい
    expect(avg).toBeLessThan(20000 * 44 * 0.1);
  });

  it('カメラを動かしても、表示台数は視錐台の中にあるセルの台数の合計と一致する', () => {
    const field = new BicycleField();
    const data = concatInstances(heapOnSurface(pileOpts), parkedRows({ seed: 4, count: 500, start: { x: -60, z: 30 }, perRow: 100 }));
    field.setInstances(data);
    const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 3000);
    const r = bicycleBoundingRadius();
    for (let t = 0; t < 40; t++) {
      const a = t * 0.16;
      camera.position.set(45 * Math.cos(a), 3 + (t % 7) * 4, 45 * Math.sin(a));
      camera.lookAt(10 * Math.sin(a * 2), 2, 0);
      field.update(camera, 720);
      const frustum = frustumOf(camera);
      const cells = field.debugCells();
      let expected = 0;
      const perLod = [0, 0, 0];
      for (const c of cells) {
        const inside = frustum.intersectsSphere(new Sphere(new Vector3(...c.center), c.radius));
        expect(c.lod >= 0).toBe(inside);
        if (inside) {
          expected += c.count;
          perLod[c.lod]! += c.count;
        }
      }
      expect(field.stats.visible).toBe(expected);
      expect(field.stats.perLod).toEqual(perLod);
      // 1台ずつの判定で視錐台に入る自転車は、すべて表示台数に含まれる（取りこぼしがない）
      let brute = 0;
      const sphere = new Sphere(new Vector3(), r);
      for (let i = 0; i < data.count; i++) {
        sphere.center.set(data.positions[i * 3]!, data.positions[i * 3 + 1]!, data.positions[i * 3 + 2]!);
        if (frustum.intersectsSphere(sphere)) brute++;
      }
      expect(field.stats.visible).toBeGreaterThanOrEqual(brute);
      expect(field.stats.perLod[0]).toBeLessThanOrEqual(2500 + 200);
    }
  });
});

describe('BicycleField: 容量と色', () => {
  it('forceLod を登録の後に設定しても、全台を描く容量を確保し直す', () => {
    const field = new BicycleField();
    field.setInstances(heapOnSurface({ ...pileOpts, count: 6000 }));
    const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 3000);
    camera.position.set(0, 60, 80);
    camera.lookAt(0, 0, 0);
    field.update(camera, 720);
    field.forceLod = 0;
    field.update(camera, 720);
    expect(field.stats.perLod[0]).toBe(field.stats.visible);
    expect(field.stats.visible).toBeGreaterThan(5000);
    expect(field.stats.overflow).toBe(0);
    const near = field.object.getObjectByName('BicycleLOD0') as Mesh;
    expect((near.geometry as InstancedBufferGeometry).instanceCount).toBe(field.stats.visible);
    field.forceLod = null;
    field.update(camera, 720);
    expect(field.stats.perLod[0]).toBeLessThan(field.stats.visible);
  });

  it('フレーム色は sRGB の8ビットのまま渡す（線形化はシェーダーで行う）', () => {
    const field = new BicycleField();
    field.forceLod = 2;
    field.setInstances(concatInstances(singleBicycle({ x: 0, y: 0, z: 0 }, 0, 0x0a0b1c), singleBicycle({ x: 2, y: 0, z: 0 }, 0, 0x1d2a52)));
    const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 3000);
    camera.position.set(1, 2, 8);
    camera.lookAt(1, 0, 0);
    field.update(camera, 720);
    const colors = new Set<string>();
    field.object.traverse((o) => {
      if (!(o instanceof Mesh) || !o.visible || !(o.geometry instanceof InstancedBufferGeometry)) return;
      const c = o.geometry.getAttribute('iColor');
      for (let i = 0; i < o.geometry.instanceCount; i++) {
        colors.add([c.getX(i), c.getY(i), c.getZ(i)].map((v) => Math.round(v * 255)).join(','));
      }
    });
    expect([...colors].sort()).toEqual(['10,11,28', '29,42,82']);
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
