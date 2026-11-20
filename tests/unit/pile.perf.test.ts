import { expect, test } from 'vitest';
import { depositPiles } from '../../src/sim/pile';
import { createSyntheticCity, mulberry32 } from '../../src/sim/syntheticCity';

test('性能: 1024×1024 格子・投入点200点', () => {
  const city = createSyntheticCity({ size: 1024, seed: 1 });
  const rand = mulberry32(3);
  const sources = Array.from({ length: 200 }, () => ({
    x: (rand() - 0.5) * 900,
    z: (rand() - 0.5) * 900,
    volume: 5000 + rand() * 20000,
  }));
  const t0 = performance.now();
  const r = depositPiles(city.grid, sources, 35);
  const ms = performance.now() - t0;
  const target = sources.reduce((a, s) => a + s.volume, 0);
  console.log(`depositPiles 1024x1024, 200 sources: ${ms.toFixed(0)} ms`);
  expect(Math.abs(r.totalVolume / target - 1)).toBeLessThan(0.005);
  // 目標は 2 秒。CI の揺らぎを見込んで 3 倍まで許容する。
  expect(ms).toBeLessThan(6000);
}, 30_000);
