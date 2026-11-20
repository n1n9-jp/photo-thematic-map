import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../public/data/bicycles');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (name: string): any => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

const stations = load('stations.json');
const municipalities = load('municipalities.json');
const timeseries = load('timeseries.json');
const summary = load('summary.json');

interface Station {
  name: string;
  municipality: string;
  lat: number | null;
  lon: number | null;
  parked: { bicycle: number; mopedGeneral: number; mopedSpecific: number; motorcycle: number; total: number };
  occupancy: { bicycle: number; total: number };
  inflow: { total: number; bicycle: number };
}
const list = stations.stations as Station[];
const total = (f: (s: Station) => number) => list.reduce((a, s) => a + f(s), 0);
const metric = (id: string) => (summary.metrics as { id: string; value: number }[]).find((m) => m.id === id)?.value;

describe('stations.json', () => {
  it('Excel の駅別の行（663行）をすべて含む', () => {
    expect(stations.count).toBe(663);
    expect(list).toHaveLength(663);
  });

  it('駅別の合計が都全体の公表値と一致する（令和7年度調査）', () => {
    expect(total((s) => s.parked.bicycle)).toBe(13394);
    expect(total((s) => s.parked.mopedGeneral)).toBe(538);
    expect(total((s) => s.parked.mopedSpecific)).toBe(55);
    expect(total((s) => s.parked.motorcycle)).toBe(379);
    expect(total((s) => s.parked.total)).toBe(14366);
    expect(total((s) => s.occupancy.total)).toBe(549491);
    expect(total((s) => s.inflow.total)).toBe(563857);
    expect(total((s) => s.inflow.bicycle)).toBe(545983);
  });

  it('すべての駅に緯度経度があり、東京都（島しょを除く）の範囲に収まる', () => {
    for (const s of list) {
      expect(s.lat, s.name).not.toBeNull();
      expect(s.lat!).toBeGreaterThan(35.5);
      expect(s.lat!).toBeLessThan(35.9);
      expect(s.lon!).toBeGreaterThan(138.94);
      expect(s.lon!).toBeLessThan(139.92);
    }
  });

  it('東京駅は千代田区の駅前付近にある', () => {
    const tokyo = list.find((s) => s.municipality === '千代田区' && s.name.startsWith('東京駅'))!;
    expect(Math.abs(tokyo.lat! - 35.681)).toBeLessThan(0.005);
    expect(Math.abs(tokyo.lon! - 139.767)).toBeLessThan(0.005);
  });
});

describe('municipalities.json', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ms = municipalities.municipalities as any[];
  it('島しょを除く 53 区市町村', () => {
    expect(ms).toHaveLength(53);
    expect(ms.filter((m) => m.area === '区部')).toHaveLength(23);
  });
  it('撤去・返還・処分の区市町村合計が公表値と一致する（令和6年度）', () => {
    const sum = (k: string) => ms.reduce((a, m) => a + m.removalFY2024[k].total, 0);
    expect(sum('removed')).toBe(188561);
    expect(sum('returned')).toBe(121425);
    expect(Math.round(sum('disposed'))).toBe(67831);
  });
  it('放置台数の区市町村合計が駅別の合計と一致する', () => {
    const sum = ms.reduce((a, m) => a + (m.parked?.bicycle ?? 0), 0);
    expect(sum).toBe(13394);
  });
});

describe('timeseries.json', () => {
  it('放置台数の推移の最新年が駅別の合計と一致する', () => {
    const last = timeseries.parking.series.at(-1);
    expect(last.surveyYear).toBe(2025);
    expect(last.parked.total).toBe(14366);
    expect(last.parked.bicycle).toBe(13394);
  });
  it('撤去台数の推移が 2010〜2024 年度の 15 年度ぶんあり、最新年度が公表値と一致する', () => {
    const s = timeseries.removal.series;
    expect(s.map((r: { fiscalYear: number }) => r.fiscalYear)).toEqual(Array.from({ length: 15 }, (_, i) => 2010 + i));
    expect(s.at(-1).removed.total).toBe(188561);
  });
});

describe('summary.json', () => {
  it('主要な数値が公表値と一致し、出典 URL を持つ', () => {
    expect(metric('bicycleParked')).toBe(13394);
    expect(metric('allParked')).toBe(14366);
    expect(metric('removedFY2024')).toBe(188561);
    expect(metric('returnedFY2024')).toBe(121425);
    expect(metric('disposedFY2024')).toBe(67831);
    for (const m of summary.metrics) {
      expect(m.unit, m.id).toBeTruthy();
      expect(m.period, m.id).toBeTruthy();
      expect(m.definition, m.id).toBeTruthy();
      expect(m.sources.length, m.id).toBeGreaterThan(0);
      for (const s of m.sources) expect(s.url).toMatch(/^https:\/\//);
    }
  });
});
