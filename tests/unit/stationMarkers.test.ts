import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateStationSites,
  distanceM,
  mergeNearbySites,
  totalBicycles,
  type StationRow,
  type StationSite,
} from '../../src/data/stations';
import {
  COLOR_STEPS,
  COLUMN_BICYCLES_PER_KM,
  CONE_BICYCLES_PER_KM3,
  colorStepIndex,
  layoutLabels,
  markerScaleText,
  markerSize,
  markerVolume,
  type LabelRequest,
  type Rect,
} from '../../src/scene/stationMarkers';

const json = JSON.parse(readFileSync(join(__dirname, '../../public/data/bicycles/stations.json'), 'utf8')) as {
  stations: StationRow[];
};
const rows = json.stations;

const row = (over: Partial<StationRow> & { bicycle?: number }): StationRow => ({
  name: over.name ?? 'X駅',
  stationNames: over.stationNames ?? ['X'],
  siteKey: over.siteKey ?? 'X',
  municipality: over.municipality ?? 'A区',
  lat: over.lat ?? 35.7,
  lon: over.lon ?? 139.7,
  parked: { bicycle: over.bicycle ?? 0 },
});

describe('aggregateStationSites（stations.json）', () => {
  const sites = aggregateStationSites(rows);

  it('合計は 13,394 台のまま変わらない', () => {
    expect(rows).toHaveLength(663);
    expect(totalBicycles(sites)).toBe(13_394);
    expect(totalBicycles(aggregateStationSites(rows, { dropEmpty: false }))).toBe(13_394);
  });

  it('siteKey ごとに合算すると594か所、東京駅と国立競技場駅をまとめて592か所、0台を除くと489か所', () => {
    expect(new Set(rows.map((r) => r.siteKey)).size).toBe(594);
    expect(aggregateStationSites(rows, { mergeDistanceM: 0, dropEmpty: false })).toHaveLength(594);
    expect(aggregateStationSites(rows, { dropEmpty: false })).toHaveLength(592);
    expect(sites).toHaveLength(489);
    expect(sites.every((s) => s.bicycles > 0)).toBe(true);
  });

  it('秋葉原が 462 台で最大。台数の多い順に並ぶ', () => {
    expect(sites[0]!.name).toBe('秋葉原');
    expect(sites[0]!.bicycles).toBe(462);
    expect(sites[1]!.bicycles).toBeLessThan(462);
    for (let i = 1; i < sites.length; i++) expect(sites[i]!.bicycles).toBeLessThanOrEqual(sites[i - 1]!.bicycles);
  });

  it('東京駅（中央区の4台）は二重橋・大手町・東京（147台）に、国立競技場駅（1台）は千駄ケ谷・国立競技場（29台）にまとまる', () => {
    const tokyo = sites.filter((s) => s.stationNames.includes('東京'));
    expect(tokyo).toHaveLength(1);
    expect(tokyo[0]!.bicycles).toBe(151);
    expect(tokyo[0]!.shortName).toBe('東京・大手町ほか');
    const stadium = sites.filter((s) => s.stationNames.includes('国立競技場'));
    expect(stadium).toHaveLength(1);
    expect(stadium[0]!.bicycles).toBe(30);
    // 台数の多い方（二重橋・大手町・東京）の側に寄る
    expect(distanceM(tokyo[0]!.lat, tokyo[0]!.lon, 35.682334, 139.764325)).toBeLessThan(40);
  });

  it('駅の位置は東京都の範囲に収まる', () => {
    for (const s of sites) {
      expect(s.lat).toBeGreaterThan(35.4);
      expect(s.lat).toBeLessThan(36);
      expect(s.lon).toBeGreaterThan(138.9);
      expect(s.lon).toBeLessThan(139.95);
    }
  });
});

describe('aggregateStationSites（小さな入力）', () => {
  it('同じ siteKey の行は台数を足し、位置は平均、区市町村は台数が最大の行のもの', () => {
    const sites = aggregateStationSites([
      row({ siteKey: 'イ', stationNames: ['イ'], municipality: 'A区', bicycle: 3, lat: 35.7, lon: 139.7 }),
      row({ siteKey: 'イ', stationNames: ['イ'], municipality: 'B区', bicycle: 5, lat: 35.702, lon: 139.704 }),
    ]);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ name: 'イ', bicycles: 8, municipality: 'B区' });
    expect(sites[0]!.lat).toBeCloseTo(35.701, 9);
    expect(sites[0]!.lon).toBeCloseTo(139.702, 9);
  });

  it('同名でも300mを超えて離れていればまとめない。距離が近くても駅名が違えばまとめない', () => {
    const near = { lat: 35.7, lon: 139.7 };
    const far = { lat: 35.7, lon: 139.7 + 0.0045 }; // 約400m
    const sameFar = aggregateStationSites([
      row({ siteKey: 'あ', stationNames: ['A'], bicycle: 1, ...near }),
      row({ siteKey: 'い', stationNames: ['A'], bicycle: 1, ...far }),
    ]);
    expect(sameFar).toHaveLength(2);
    const otherName = aggregateStationSites([
      row({ siteKey: 'あ', stationNames: ['A'], bicycle: 1, ...near }),
      row({ siteKey: 'い', stationNames: ['B'], bicycle: 1, ...near }),
    ]);
    expect(otherName).toHaveLength(2);
    const merged = aggregateStationSites([
      row({ siteKey: 'あ', stationNames: ['A'], bicycle: 1, ...near }),
      row({ siteKey: 'い', stationNames: ['A', 'B'], bicycle: 2, lat: 35.7, lon: 139.7 + 0.002 }), // 約180m
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ name: 'い', bicycles: 3 });
  });

  it('台数0の場所は既定で除き、dropEmpty:false なら残す', () => {
    const input = [row({ siteKey: 'あ', bicycle: 0 }), row({ siteKey: 'い', stationNames: ['い'], bicycle: 2, lat: 35.8 })];
    expect(aggregateStationSites(input)).toHaveLength(1);
    expect(aggregateStationSites(input, { dropEmpty: false })).toHaveLength(2);
  });

  it('mergeNearbySites は全体が0台でも位置を求められる', () => {
    const a: StationSite = {
      name: 'a',
      shortName: 'a',
      municipality: 'x',
      lat: 35.7,
      lon: 139.7,
      bicycles: 0,
      capacity: 0,
      occupancy: 0,
      vacancyCoversParked: true,
      stationNames: ['A'],
    };
    const b: StationSite = { ...a, name: 'b', lat: 35.7, lon: 139.7006 };
    const [m] = mergeNearbySites([a, b], 300);
    expect(m!.lon).toBeCloseTo(139.7003, 9);
  });
});

describe('印の大きさ', () => {
  it('柱: 高さは台数に比例し、1km＝50台', () => {
    expect(COLUMN_BICYCLES_PER_KM).toBe(50);
    expect(markerSize('column', 50).height).toBeCloseTo(1000, 9);
    expect(markerSize('column', 462).height).toBeCloseTo(9240, 9);
    expect(markerSize('column', 1).height).toBeCloseTo(20, 9);
    expect(markerSize('column', 50).radius).toBe(markerSize('column', 400).radius);
  });

  it('山: 体積は台数に比例し、1km³＝500台', () => {
    expect(CONE_BICYCLES_PER_KM3).toBe(500);
    for (const n of [1, 10, 100, 462]) {
      const v = markerVolume('cone', markerSize('cone', n));
      expect(v).toBeCloseTo((n / 500) * 1e9, -3);
    }
    const s = markerSize('cone', 100);
    expect(s.height).toBeCloseTo(s.radius * 2, 9);
    // 体積が2倍なら、半径は ³√2 倍
    expect(markerSize('cone', 200).radius / markerSize('cone', 100).radius).toBeCloseTo(Math.cbrt(2), 9);
  });

  it('凡例の文言は定数から作る', () => {
    expect(markerScaleText('column')).toBe('柱の高さ 1km ＝ 50台');
    expect(markerScaleText('cone')).toContain('山の体積 1km³ ＝ 500台');
  });
});

describe('色の段階', () => {
  it('台数の境目で段階が変わる', () => {
    const at = (n: number): number => colorStepIndex(n);
    expect([1, 9, 10, 29, 30, 99, 100, 199, 200, 462].map(at)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('段階は隙間も重なりもなく、少ない駅ほど明るい', () => {
    for (let i = 1; i < COLOR_STEPS.length; i++) expect(COLOR_STEPS[i]!.min).toBe(COLOR_STEPS[i - 1]!.max! + 1);
    expect(COLOR_STEPS[COLOR_STEPS.length - 1]!.max).toBeNull();
    const lum = (c: number): number => 0.299 * (c >> 16) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
    for (let i = 1; i < COLOR_STEPS.length; i++) expect(lum(COLOR_STEPS[i]!.color)).toBeLessThan(lum(COLOR_STEPS[i - 1]!.color));
  });

  it('実データの駅の分布: 最大の段階（200台以上）は2か所だけ', () => {
    const sites = aggregateStationSites(rows);
    const counts = COLOR_STEPS.map((_, i) => sites.filter((s) => colorStepIndex(s.bicycles) === i).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(sites.length);
    expect(counts[4]).toBe(3); // 秋葉原462・高円寺229・小川町222
  });
});

describe('layoutLabels', () => {
  const viewport = { width: 390, height: 600 };
  const rectOf = (p: { x: number; y: number; w: number; h: number }): Rect => ({ x: p.x, y: p.y, w: p.w, h: p.h });
  const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('密集した印でも、ラベルは重ならず画面内に収まる', () => {
    const requests: LabelRequest[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      ax: 200 + (i % 3) * 6,
      ay: 300 + Math.floor(i / 3) * 5,
      w: 70,
      h: 30,
    }));
    const placed = layoutLabels(requests, viewport);
    expect(placed).toHaveLength(10);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(viewport.width);
      expect(p.y + p.h).toBeLessThanOrEqual(viewport.height);
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(intersects(rectOf(placed[i]!), rectOf(placed[j]!))).toBe(false);
    }
  });

  it('障害物と他の印には重ならない', () => {
    const requests: LabelRequest[] = [
      { id: 'a', ax: 100, ay: 100, w: 60, h: 28 },
      { id: 'b', ax: 180, ay: 90, w: 60, h: 28 },
    ];
    const obstacle: Rect = { x: 110, y: 60, w: 120, h: 40 };
    const placed = layoutLabels(requests, viewport, [obstacle]);
    expect(placed).toHaveLength(2);
    for (const p of placed) expect(intersects(rectOf(p), obstacle)).toBe(false);
    const a = placed.find((p) => p.id === 'a')!;
    expect(intersects(rectOf(a), { x: 177, y: 87, w: 6, h: 6 })).toBe(false);
  });

  it('先頭（台数の多い方）ほど印の近くに置く。近くに置けるなら引き出し線は要らない', () => {
    const [p] = layoutLabels([{ id: 'a', ax: 200, ay: 300, w: 60, h: 28 }], viewport);
    expect(p!.leader).toBe(false);
    expect(Math.hypot(p!.x - 200, p!.y + p!.h / 2 - 300)).toBeLessThan(60);
  });

  it('bounds を指定すると、ラベルはその範囲の外に出ない', () => {
    const bounds: Rect = { x: 200, y: 0, w: 190, h: 300 };
    const requests: LabelRequest[] = Array.from({ length: 6 }, (_, i) => ({ id: String(i), ax: 260 + i * 20, ay: 120 + i * 20, w: 70, h: 30 }));
    const placed = layoutLabels(requests, viewport, [], { bounds });
    expect(placed.length).toBeGreaterThan(0);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(bounds.x);
      expect(p.y).toBeGreaterThanOrEqual(bounds.y);
      expect(p.x + p.w).toBeLessThanOrEqual(bounds.x + bounds.w);
      expect(p.y + p.h).toBeLessThanOrEqual(bounds.y + bounds.h);
    }
  });

  it('置き場がなければ出さない（重ねない）', () => {
    const placed = layoutLabels([{ id: 'a', ax: 50, ay: 50, w: 60, h: 28 }], { width: 100, height: 60 }, [
      { x: 0, y: 0, w: 100, h: 60 },
    ]);
    expect(placed).toEqual([]);
  });
});
