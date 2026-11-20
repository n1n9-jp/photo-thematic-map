import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { layoutStation, prepareStreetMap } from '../../src/sim/stationLayout';
import { createSyntheticCity } from '../../src/sim/syntheticCity';

interface StationRow {
  siteKey: string;
  parked: { bicycle: number };
}

/** 駅別データを siteKey で合算した台数（約594か所）。 */
function siteCounts(): number[] {
  const json = JSON.parse(readFileSync('public/data/bicycles/stations.json', 'utf8')) as { stations: StationRow[] };
  const sums = new Map<string, number>();
  for (const s of json.stations) sums.set(s.siteKey, (sums.get(s.siteKey) ?? 0) + s.parked.bicycle);
  return [...sums.values()];
}

test('性能: 都内の全か所ぶんの配置（1km 四方・セル 1m の合成街区）', () => {
  const counts = siteCounts();
  const total = counts.reduce((a, b) => a + b, 0);
  expect(total).toBe(13394);

  const city = createSyntheticCity({ size: 1040, seed: 3 });
  const t0 = performance.now();
  const map = prepareStreetMap(city.grid);
  const prepareMs = performance.now() - t0;

  const per: number[] = [];
  let placed = 0;
  counts.forEach((n, i) => {
    const t = performance.now();
    const l = layoutStation(map, { x: ((i * 37) % 200) - 100, z: ((i * 53) % 200) - 100 }, n, i + 1);
    per.push(performance.now() - t);
    placed += l.count;
  });
  expect(placed).toBe(total);
  const layoutMs = per.reduce((a, b) => a + b, 0);
  const sorted = [...per].sort((a, b) => a - b);
  console.log(
    `stationLayout: ${counts.length} か所 ${total} 台 / 路上判定 ${prepareMs.toFixed(0)} ms（1040×1040 セル、1回）` +
      ` / 配置 合計 ${layoutMs.toFixed(0)} ms・1か所平均 ${(layoutMs / counts.length).toFixed(2)} ms` +
      `・中央値 ${sorted[sorted.length >> 1]!.toFixed(2)} ms・最大 ${sorted[sorted.length - 1]!.toFixed(1)} ms`,
  );
  // 目安: 路上判定 0.3 秒、配置の合計 1.5 秒。CI の揺らぎを見込んで 4 倍まで許容する。
  expect(prepareMs).toBeLessThan(1200);
  expect(layoutMs).toBeLessThan(6000);
}, 60_000);
