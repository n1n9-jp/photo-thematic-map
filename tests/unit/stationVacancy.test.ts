import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateStationSites,
  countVacancyByRow,
  countVacancyBySite,
  shortNameOf,
  totalBicycles,
  vacancyCoversParked,
  type StationRow,
} from '../../src/data/stations';
import { FACTS } from '../../src/story/content/facts';

const rows = (
  JSON.parse(readFileSync(join(__dirname, '../../public/data/bicycles/stations.json'), 'utf8')) as { stations: StationRow[] }
).stations;

/** 場所（柱）の単位で、空きが放置台数以上の数。行の単位の 425 より少ない（実データから求めて固定）。 */
const SITE_ENOUGH = 398;

describe('駐輪場の空き（場面4）', () => {
  it('空きが放置台数以上かは、収容能力 − 止まっていた台数 と放置台数の比較（等しければ以上）', () => {
    expect(vacancyCoversParked(100, 60, 40)).toBe(true);
    expect(vacancyCoversParked(100, 60, 41)).toBe(false);
    expect(vacancyCoversParked(50, 60, 1)).toBe(false); // 定員を超えて止まっている（空きが負）
    expect(vacancyCoversParked(0, 0, 1)).toBe(false); // 駐輪場がない
  });

  it('行の単位で数えると、放置自転車がある行は530、そのうち空きが放置台数以上は425（台本の数値）', () => {
    expect(rows).toHaveLength(663);
    const byRow = countVacancyByRow(rows);
    expect(byRow).toEqual({ withParked: 530, enough: 425 });
    expect(byRow.withParked).toBe(FACTS.stationsWithParked.value);
    expect(byRow.enough).toBe(FACTS.stationsVacancyExceeds.value);
  });

  it('場所（柱）の単位では489か所。色分けは、その場所の行をまとめた値で判定する', () => {
    const sites = aggregateStationSites(rows);
    expect(sites).toHaveLength(489);
    expect(totalBicycles(sites)).toBe(13_394);
    const bySite = countVacancyBySite(sites);
    expect(bySite.withParked).toBe(489);
    // 場所の単位の数（行の単位の 425 とは一致しない。複数の行・駅をまとめて判定するため）
    expect(bySite.withParked - bySite.enough).toBe(91);
    expect(bySite.enough).toBe(SITE_ENOUGH);
    for (const s of sites) {
      expect(s.vacancyCoversParked).toBe(vacancyCoversParked(s.capacity, s.occupancy, s.bicycles));
    }
  });

  it('複数の行をまとめた場所は、収容能力・止まっていた台数・放置台数をそれぞれ合計して判定する', () => {
    const mk = (parked: number, capacity: number, occupancy: number): StationRow => ({
      name: 'X駅',
      stationNames: ['X'],
      siteKey: 'X',
      municipality: 'A区',
      lat: 35.7,
      lon: 139.7,
      parked: { bicycle: parked },
      capacity: { bicycle: capacity },
      occupancy: { bicycle: occupancy },
    });
    // 行 a: 空き 10 ≥ 放置 5（足りる）、行 b: 空き 0 < 放置 8（足りない）。合計は 空き 10 < 放置 13
    const [site] = aggregateStationSites([mk(5, 50, 40), mk(8, 30, 30)]);
    expect(site).toMatchObject({ bicycles: 13, capacity: 80, occupancy: 70, vacancyCoversParked: false });
    const [ok] = aggregateStationSites([mk(5, 50, 40), mk(3, 30, 30)]);
    expect(ok).toMatchObject({ bicycles: 8, capacity: 80, occupancy: 70, vacancyCoversParked: true });
  });
});

describe('ラベルの名前', () => {
  it('主な駅を2つまで「・」で並べ、3駅以上をまとめた場所は「ほか」を付ける', () => {
    expect(shortNameOf(['秋葉原'], 'k')).toBe('秋葉原');
    expect(shortNameOf(['半蔵門', '麹町'], 'k')).toBe('半蔵門・麹町');
    expect(shortNameOf(['東京', '大手町', '二重橋'], 'k')).toBe('東京・大手町ほか');
    expect(shortNameOf([], 'k')).toBe('k');
  });

  it('実データ: 東京駅の場所は「東京・大手町ほか」。路線の多い駅が先に来る', () => {
    const sites = aggregateStationSites(rows);
    const tokyo = sites.find((s) => s.stationNames.includes('東京'))!;
    expect(tokyo.stationNames.slice(0, 2)).toEqual(['東京', '大手町']);
    expect(tokyo.shortName).toBe('東京・大手町ほか');
    expect(sites[0]!.shortName).toBe('秋葉原');
  });
});
