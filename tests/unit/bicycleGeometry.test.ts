import { describe, expect, it } from 'vitest';
import {
  FRAME_PALETTE,
  LOD_TRIANGLE_BUDGET,
  createBicycleGeometry,
  pickFrameColor,
  triangleCount,
  type BicycleLod,
} from '../../src/scene/bicycle/geometry';

const LODS: BicycleLod[] = [0, 1, 2];

describe('ママチャリ形状', () => {
  it.each(LODS)('LOD%i は三角形数の上限以内', (lod) => {
    const geo = createBicycleGeometry(lod);
    const n = triangleCount(geo);
    console.log(`LOD${lod}: ${n} triangles`);
    expect(n).toBeLessThanOrEqual(LOD_TRIANGLE_BUDGET[lod]);
    expect(n).toBeGreaterThan(LOD_TRIANGLE_BUDGET[lod] * 0.5);
  });

  it('近景は実寸（全長1.8m・幅0.6m・高さ1.05m）で原点が接地面の中央', () => {
    const geo = createBicycleGeometry(0);
    const bb = geo.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(1.8, 1);
    expect(bb.max.z - bb.min.z).toBeCloseTo(0.6, 1);
    expect(bb.max.y).toBeCloseTo(1.05, 1);
    expect(bb.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(bb.min.y).toBeLessThan(0.01);
    expect(Math.abs(bb.max.x + bb.min.x)).toBeLessThan(0.05);
  });

  it('遠景・中景の外形は近景とほぼ一致する', () => {
    const near = createBicycleGeometry(0).boundingBox!;
    for (const lod of [1, 2] as const) {
      const bb = createBicycleGeometry(lod).boundingBox!;
      expect(Math.abs(bb.min.x - near.min.x)).toBeLessThan(0.08);
      expect(Math.abs(bb.max.x - near.max.x)).toBeLessThan(0.08);
      expect(Math.abs(bb.max.y - near.max.y)).toBeLessThan(0.08);
      expect(bb.min.y).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it('頂点属性 color と frameMask を持ち、フレーム部分が存在する', () => {
    for (const lod of LODS) {
      const geo = createBicycleGeometry(lod);
      const mask = geo.getAttribute('frameMask');
      expect(geo.getAttribute('color').count).toBe(mask.count);
      let frame = 0;
      for (let i = 0; i < mask.count; i++) frame += mask.getX(i);
      expect(frame).toBeGreaterThan(0);
      expect(frame).toBeLessThan(mask.count);
    }
  });

  it('パレットの割合は合計1で、乱数に応じて全色が選ばれうる', () => {
    const sum = FRAME_PALETTE.reduce((a, e) => a + e.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(pickFrameColor(i / 1000));
    expect(seen.size).toBe(FRAME_PALETTE.length);
    expect(pickFrameColor(0.999999)).toBe(FRAME_PALETTE[FRAME_PALETTE.length - 1]!.hex);
  });
});
