import { expect, test } from 'vitest';
import { computePileGrowth } from '../../src/sim/pile';
import { createSyntheticCity } from '../../src/sim/syntheticCity';

test('成長: t について単調で、体積は t に比例する', () => {
  const city = createSyntheticCity({ size: 256, seed: 3 });
  const sources = [
    { x: 0, z: 0, volume: 150000 },
    { x: 48, z: 5, volume: 40000 },
    { x: -60, z: -48, volume: 20000 },
  ];
  const growth = computePileGrowth(city.grid, sources, 35, { stages: 10 });
  const n = city.grid.width * city.grid.height;
  const total = growth.final.totalVolume;
  let prev: Float32Array = new Float32Array(n);
  let decreases = 0;
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    const th = growth.thicknessAt(t);
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (th[i]! < prev[i]!) decreases++;
      v += th[i]!;
    }
    expect(Math.abs(v * city.grid.cellSize ** 2 - t * total)).toBeLessThan(0.005 * total + 1e-9);
    prev = th;
  }
  expect(decreases).toBe(0);
  const last = growth.thicknessAt(1);
  expect(last).toEqual(growth.final.thickness);
  const zero = growth.thicknessAt(0);
  expect(zero.every((x) => x === 0)).toBe(true);
}, 20_000);
