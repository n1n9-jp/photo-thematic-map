import { expect, test } from 'vitest';
import { rasterTriangle } from '../../scripts/bake/index';

const tri = (pts: number[][]): [Float64Array, Float64Array, Float64Array] => [
  Float64Array.from(pts.map((p) => p[0] as number)),
  Float64Array.from(pts.map((p) => p[1] as number)),
  Float64Array.from(pts.map((p) => p[2] as number)),
];

test('水平な正方形（2 三角形）は中心が内側のセルをちょうど覆い、高さを補間する', () => {
  const W = 10;
  const H = 10;
  const top = new Float32Array(W * H).fill(-Infinity);
  const visit = (c: number, y: number): void => {
    if (y > (top[c] as number)) top[c] = y;
  };
  // x: 2〜6, z: 3〜5（セルの中心 x=2.5..5.5 の 4 列, z=3.5,4.5 の 2 行）
  const [x1, y1, z1] = tri([[2, 10, 3], [6, 10, 3], [6, 10, 5]]);
  const [x2, y2, z2] = tri([[2, 10, 3], [6, 10, 5], [2, 10, 5]]);
  rasterTriangle(x1, y1, z1, 0, 0, 1, W, H, visit);
  rasterTriangle(x2, y2, z2, 0, 0, 1, W, H, visit);
  const covered = [...top.keys()].filter((i) => Number.isFinite(top[i] as number));
  expect(covered.length).toBe(8);
  expect(covered.every((i) => top[i] === 10)).toBe(true);
});

test('傾いた面の高さは重心座標で補間し、真上から見て面積のない壁は無視する', () => {
  const out: [number, number][] = [];
  const [x, y, z] = tri([[0, 0, 0], [4, 4, 0], [0, 0, 4]]);
  rasterTriangle(x, y, z, 0, 0, 1, 4, 4, (c, v) => out.push([c, v]));
  // セル (col=1,row=0) の中心 x=1.5 → y=1.5
  expect(out.find(([c]) => c === 1)?.[1]).toBeCloseTo(1.5, 9);
  const wall: number[] = [];
  const [wx, wy, wz] = tri([[0, 0, 0.5], [4, 0, 0.5], [4, 9, 0.5]]);
  rasterTriangle(wx, wy, wz, 0, 0, 1, 4, 4, (c) => wall.push(c));
  expect(wall).toEqual([]);
});
