import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { BicycleField, maxVertexDistance, bicycleBoundingRadius } from '../../src/scene/bicycle/field';
import { DOT_TRIANGLE_BUDGET, createBicycleDotGeometry, triangleCount } from '../../src/scene/bicycle/geometry';
import { concatInstances, singleBicycle } from '../../src/scene/bicycle/layouts';

describe('点景', () => {
  it('形状は 10 三角形以下で、視錐台の判定の半径に収まる', () => {
    const geo = createBicycleDotGeometry();
    expect(triangleCount(geo)).toBeLessThanOrEqual(DOT_TRIANGLE_BUDGET);
    expect(maxVertexDistance(geo)).toBeLessThan(bicycleBoundingRadius());
    geo.dispose();
  });

  it('画面上で閾値より小さく見える遠景のセルは点景で描き、三角形数に数える', () => {
    const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 5000);
    camera.position.set(0, 1.5, 4);
    camera.lookAt(0, 0.5, -100);
    camera.updateMatrixWorld();
    const data = concatInstances(
      singleBicycle({ x: 0, y: 0, z: 0 }, 0, 0xffffff),
      singleBicycle({ x: 0, y: 0, z: -150 }, 0, 0),
      singleBicycle({ x: 0, y: 0, z: -900 }, 0, 0),
    );
    const plain = new BicycleField();
    plain.setInstances(data);
    plain.update(camera, 720);
    expect(plain.stats.perLod).toEqual([1, 0, 2]);
    expect(plain.stats.dots).toBe(0);

    // 720px・fov 45° で f ≈ 869px。全長 1.8m が 6px になる距離は約 261m
    const field = new BicycleField({ dotPixelThreshold: 6 });
    field.setInstances(data);
    field.update(camera, 720);
    expect(field.stats.perLod).toEqual([1, 0, 1]);
    expect(field.stats.dots).toBe(1);
    expect(field.stats.visible).toBe(3);
    const t = field.stats.trianglesPerInstance;
    expect(field.stats.triangles).toBe(t[0] + t[2] + field.stats.trianglesPerDot);

    // 余裕幅: 切り替え距離の少し内側に近づいても点景のまま、十分近づくと遠景に戻る
    camera.position.set(0, 1.5, -900 + 261 * 0.95);
    camera.updateMatrixWorld();
    field.update(camera, 720);
    expect(field.stats.dots).toBeGreaterThanOrEqual(1);
    camera.position.set(0, 1.5, -900 + 261 * 0.7);
    camera.updateMatrixWorld();
    field.update(camera, 720);
    expect(field.stats.dots).toBe(0);
    field.dispose();
    plain.dispose();
  });

  it('色の調子は uniform で設定できる', () => {
    const field = new BicycleField();
    field.tone = { lift: 0.5, saturation: 1.2, shadeFloor: 0.25 };
    expect(field.tone).toEqual({ lift: 0.5, saturation: 1.2, shadeFloor: 0.25 });
    field.dispose();
  });
});
