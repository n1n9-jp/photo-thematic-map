/**
 * 「データと方法」の節の文面が、facts.ts の定数と一致し、本文と食い違う数字を含まないこと。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildMethodsModel, modelLinks, modelText, pileHeightRange } from '../../src/app/methods/content';
import { PILE_SITES } from '../../src/app/modules/pileSites';
import { PILE_DEVICE_PROFILES } from '../../src/app/modules/pileModule';
import { DEFAULT_MERGE_DISTANCE_M } from '../../src/data/stations';
import { COLUMN_BICYCLES_PER_KM } from '../../src/scene/stationMarkers';
import { PILE_DEFAULTS, computePileScene } from '../../src/scene/pileScene/compute';
import { latLonToLocal } from '../../src/geo/enu';
import {
  BUILDING_DISTRICTS,
  coneHeightOnFlatGroundM,
  DATA_YEARS,
  FACTS,
  PILE_ASSUMPTIONS,
  PILE_SURFACE_PLACED,
  PILES,
  REMOVED_FY2024_WITH_MOPEDS,
  STATION_PILLARS,
  TOCHO_HEIGHT_M,
  TOKYO_DOME_VOLUME_M3,
  type Fact,
} from '../../src/story/content/facts';
import { formatDecimal, formatJaCount } from '../../src/story/content/format';
import { SCRIPT } from '../../src/story/content/script';
import { readCityGrid } from '../../scripts/bake/readGrid';

const model = buildMethodsModel();
const text = modelText(model);

const n = (f: Fact): string => (f.fractionDigits ? formatDecimal(f.value, f.fractionDigits) : formatJaCount(f.value));

describe('節の構成', () => {
  test('項目は5つで、見出しの順が決まっている', () => {
    expect(model.sections.map((s) => s.heading)).toEqual([
      'この作品について',
      '放置自転車の台数：出典と数え方',
      '自転車の置き方：どこまでが事実か',
      '地図と3Dモデル：出典',
      '制作の技術',
    ]);
    expect(new Set(model.sections.map((s) => s.id)).size).toBe(5);
  });

  test('作品の先頭へ戻るリンクがある', () => {
    expect(model.backToTop).toEqual({ text: '作品の先頭へ戻る', href: '#top' });
  });

  test('非営利・個人の制作物で、国や都の作成・監修・保証ではないと書いてある', () => {
    expect(text).toContain('個人が非営利で作りました');
    expect(text).toContain('国土交通省、国土地理院、東京都が作成・監修・保証したものではありません');
  });
});

describe('リンク', () => {
  const links = modelLinks(model);
  test('外へのリンクはすべて https の URL', () => {
    const external = links.filter((h) => !h.startsWith('#'));
    expect(external.length).toBeGreaterThanOrEqual(10);
    for (const href of external) expect(() => new URL(href)).not.toThrow();
    for (const href of external) expect(href.startsWith('https://')).toBe(true);
  });

  test('指定された出典のリンクがある', () => {
    for (const href of [
      'https://www.tomin-anzen.metro.tokyo.lg.jp/kotsu/jitensha/houchi/0000001962',
      'https://www.mlit.go.jp/plateau/',
      'https://docs.plateauview.mlit.go.jp/datasets/ortho/',
      'https://maps.gsi.go.jp/development/ichiran.html',
      'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html',
    ]) {
      expect(links).toContain(href);
    }
  });
});

describe('文面の数値は facts.ts の定数と一致する', () => {
  test('放置自転車の台数と数え方', () => {
    expect(text).toContain(`都内全体で${n(FACTS.totalParked)}台）は自転車だけの値`);
    expect(text).toContain(`放置自転車が1台以上ある${n(STATION_PILLARS)}か所に立てています`);
    expect(text).toContain(`「${n(FACTS.stationsWithParked)}駅」「${n(FACTS.stationsVacancyExceeds)}駅」は、表の行の数`);
    expect(text).toContain(`${n(FACTS.removedFY2024)}台）は自転車だけの値で、原動機付自転車を含む公表値（${n(REMOVED_FY2024_WITH_MOPEDS)}台）`);
    expect(text).toContain(`${n(FACTS.peakParked1990)}台は、自転車・原動機付自転車・自動二輪車の計`);
    expect(text).toContain(`同じ数え方で2025年を数えると${n(FACTS.sameMethodParked2025)}台です`);
    expect(text).toContain('2025年10月に、各区市町村が晴天の平日を1日選び、午前11時ごろに1回数えた');
    expect(text).toContain('駅からおおむね半径500メートル以内');
  });

  test('秋葉原・柱', () => {
    expect(text).toContain(`秋葉原の${n(FACTS.akihabaraParked)}台`);
    expect(text).toContain(`柱の高さ1キロメートルが${COLUMN_BICYCLES_PER_KM}台（1台あたり${formatJaCount(1000 / COLUMN_BICYCLES_PER_KM)}メートル）`);
  });

  test('山の仮定と結果', () => {
    expect(text).toContain(`1台が占める体積を${PILE_ASSUMPTIONS.unitVolumeM3.toFixed(2)}立方メートル`);
    expect(text).toContain(`安息角）を${PILE_ASSUMPTIONS.reposeAngleDeg}°と仮定`);
    expect(text).toContain(`${n(FACTS.removedFY2024)}台）の山で高さ約${n(FACTS.yearPileHeight)}メートル`);
    expect(text).toContain(`${n(FACTS.removed15Years)}台）の山で高さ約${n(FACTS.cumulativePileHeight)}メートル`);
    // 本文の山の高さ（facts の PILES）と同じ値
    expect(FACTS.yearPileHeight.value).toBe(Math.round(PILES.removedFY2024.heightM));
    expect(FACTS.cumulativePileHeight.value).toBe(Math.round(PILES.removed15Years.heightM));
    expect(text).toContain('実際に積んで測った値ではありません');
    expect(text).toContain('山積みの自転車が占める体積を測った資料は見つかりませんでした');
    expect(text).toContain(`斜面の角度も、自転車の山を測った資料は見つかりませんでした。${PILE_ASSUMPTIONS.reposeAngleDeg}°は仮定の値です`);
    expect(text).toContain('撤去された自転車が、実際にそこに積まれているわけではありません');
    expect(text).toContain(`1台あたり約0.13立方メートル。40フィートコンテナに500〜575台`);
    expect(text).toContain('約1.13立方メートル');
  });

  test('仮定を変えたときの山の高さの幅は、平らな地面の円錐の概算と一致する', () => {
    const r = pileHeightRange();
    // 円錐の体積 V = π h³ / (3 tan²θ)
    const t = Math.tan((PILE_ASSUMPTIONS.reposeAngleDeg * Math.PI) / 180);
    const hOf = (count: number, v: number): number => Math.round(Math.cbrt((3 * count * v * t * t) / Math.PI));
    expect(r.year).toEqual([hOf(FACTS.removedFY2024.value, 0.13), hOf(FACTS.removedFY2024.value, 1.13)]);
    expect(r.fifteenYears).toEqual([hOf(FACTS.removed15Years.value, 0.13), hOf(FACTS.removed15Years.value, 1.13)]);
    expect(r.year).toEqual([23, 46]);
    expect(r.fifteenYears[0]).toBe(71);
    expect(coneHeightOnFlatGroundM(FACTS.removed15Years.value, 1.13, 35)).toBeCloseTo(145.3, 1);
    expect(r.fifteenYears[1]).toBe(145);
    expect(text).toContain(`1年ぶんが約${r.year[0]}メートル、15年ぶんが約${r.fifteenYears[0]}メートル`);
    expect(text).toContain(`1年ぶんが約${r.year[1]}メートル、15年ぶんが約${r.fifteenYears[1]}メートル`);
  });

  test('15年ぶんの山の描き方', () => {
    const L = PILE_SURFACE_PLACED.largeDevice;
    const S = PILE_SURFACE_PLACED.smallDevice;
    expect(text).toContain(`描いているのは${formatJaCount(L.count)}台（表面から深さ${L.surfaceDepthM.toFixed(1)}メートルまで`);
    expect(text).toContain(`小さな端末では${formatJaCount(S.count)}台、深さ${S.surfaceDepthM.toFixed(1)}メートルまで`);
    expect(text).toContain(`表している${n(FACTS.removed15Years)}台の約3％`);
    expect(text).toContain(`1年ぶんの山は、${n(FACTS.removedFY2024)}台をすべて置いています`);
  });

  test('出典: 年度・都庁の高さ・東京ドームの容積', () => {
    expect(text).toContain(`3D都市モデル（東京都、${DATA_YEARS.plateauBuildings}年度）`);
    expect(text).toContain(`${DATA_YEARS.plateauOrtho}年度`);
    expect(text).toContain(`鉄道データ、国土交通省、${DATA_YEARS.stations}年度`);
    expect(text).toContain(`都庁第一本庁舎の高さ（${formatDecimal(TOCHO_HEIGHT_M, 1)}メートル）`);
    expect(text).toContain(`東京ドームの容積（約${formatJaCount(TOKYO_DOME_VOLUME_M3)}立方メートル）`);
    // 本文（場面6）の値と同じ換算
    expect(Math.round(FACTS.tochoHeight.value)).toBe(Math.round(TOCHO_HEIGHT_M));
    expect(FACTS.cumulativePileDomes.value).toBe(Number((FACTS.cumulativePileVolume.value / TOKYO_DOME_VOLUME_M3).toFixed(1)));
  });
});

describe('節の中の数字に、本文と食い違うものがない', () => {
  /** 本文の定数（FACTS と facts.ts の定数）から出る、節に現れてよい数字（文面の書き方ごと）。 */
  const allowed = new Set<string>();
  const add = (v: number, digits = 0): void => {
    allowed.add(formatDecimal(v, digits));
    allowed.add(formatJaCount(v));
    allowed.add(String(v));
  };
  for (const f of Object.values(FACTS)) add(f.value, f.fractionDigits ?? 0);
  add(REMOVED_FY2024_WITH_MOPEDS.value);
  add(STATION_PILLARS.value);
  add(TOCHO_HEIGHT_M, 1);
  add(TOKYO_DOME_VOLUME_M3);
  add(COLUMN_BICYCLES_PER_KM);
  add(DEFAULT_MERGE_DISTANCE_M);
  add(1000 / COLUMN_BICYCLES_PER_KM);
  add(PILE_ASSUMPTIONS.unitVolumeM3, 2);
  add(PILE_ASSUMPTIONS.reposeAngleDeg);
  add(PILE_ASSUMPTIONS.reference.containerPerBicycleM3, 2);
  add(PILE_ASSUMPTIONS.reference.boxPerBicycleM3, 2);
  add(PILE_ASSUMPTIONS.reference.containerBicyclesMin);
  add(PILE_ASSUMPTIONS.reference.containerBicyclesMax);
  for (const d of [PILE_SURFACE_PLACED.largeDevice, PILE_SURFACE_PLACED.smallDevice]) {
    add(d.count);
    add(d.surfaceDepthM, 1);
  }
  add(BUILDING_DISTRICTS.far.length);
  for (const v of [PILES.removedFY2024.heightM, PILES.removed15Years.heightM]) add(Math.round(v));
  const r = pileHeightRange();
  for (const v of [...r.year, ...r.fifteenYears]) add(v);
  // 日付・年度・版（facts.ts の SURVEY・FISCAL_YEAR などと、資料の名前に含まれる年度）
  // 100・50 は旧方式の基準（自転車100台以上、原付・自二50台以上の駅だけを数える）
  for (const v of [2025, 2026, 2024, 2010, 2011, 1990, 10, 11, 3, 26, 7, 23, 40, 100, 50, 3, 1, 15]) add(v);

  test('数字（桁区切り・小数・「万」を含む）がすべて、facts.ts の定数から出たものか、日付・年度・版のいずれか', () => {
    // 数字の並び（全角を半角にしたうえで）: 1万3,394 / 0.35 / 579万8,477 / 500 など
    const normalized = text.normalize('NFKC');
    const tokens = normalized.match(/\d[\d,]*(?:\.\d+)?(?:万(?:\d[\d,]*)?)?/g) ?? [];
    expect(tokens.length).toBeGreaterThan(40);
    const unknown = tokens.filter((t) => !allowed.has(t) && !allowed.has(t.replace(/,/g, '')));
    expect(unknown).toEqual([]);
  });

  test('本文（台本）に出てくる同じ数値は、節でも同じ書き方になっている', () => {
    const script = SCRIPT.map((s) => [s.text.heading, ...s.text.paragraphs].join('\n')).join('\n');
    for (const f of [FACTS.totalParked, FACTS.akihabaraParked, FACTS.stationsWithParked, FACTS.stationsVacancyExceeds, FACTS.removedFY2024, FACTS.removed15Years, FACTS.peakParked1990, FACTS.sameMethodParked2025]) {
      const s = `${n(f)}${f.unit}`;
      expect(script, `台本に ${s} がない`).toContain(s);
      expect(text, `節に ${s} がない`).toContain(s);
    }
    // 山の高さは本文と同じ
    expect(script).toContain(`${n(FACTS.cumulativePileHeight)}${FACTS.cumulativePileHeight.unit}`);
    expect(text).toContain(`${n(FACTS.cumulativePileHeight)}${FACTS.cumulativePileHeight.unit}`);
  });
});

describe('facts.ts の定数が、本編の計算・凡例と一致する', () => {
  test('山の仮定は PILE_DEFAULTS と同じ', () => {
    expect(PILE_ASSUMPTIONS.unitVolumeM3).toBe(PILE_DEFAULTS.unitVolume);
    expect(PILE_ASSUMPTIONS.reposeAngleDeg).toBe(PILE_DEFAULTS.angle);
  });

  test('15年ぶんの山の表層の深さと、置く台数は、堆積計算（端末の種類ごと）の結果と同じ', () => {
    expect(PILE_SURFACE_PLACED.largeDevice.surfaceDepthM).toBe(PILE_DEVICE_PROFILES.large.surfaceDepth);
    expect(PILE_SURFACE_PLACED.smallDevice.surfaceDepthM).toBe(PILE_DEVICE_PROFILES.small.surfaceDepth);
    const site = PILE_SITES.fifteenYears;
    const grid = readCityGrid(site.grid).surface;
    const p = latLonToLocal({ lat: site.lat, lon: site.lon });
    for (const d of [PILE_SURFACE_PLACED.largeDevice, PILE_SURFACE_PLACED.smallDevice]) {
      const result = computePileScene(grid, { x: p.x, z: p.z, count: site.count, mode: site.mode, surfaceDepth: d.surfaceDepthM });
      expect(result.placedCount).toBe(d.count);
    }
    // 1年ぶんの山は全台
    expect(PILE_SITES.year.mode).toBe('full');
    expect(PILE_SITES.year.count).toBe(FACTS.removedFY2024.value);
  }, 120_000);
});

describe('建物に使った区（事前変換のメタ情報との照合。変換していないときは飛ばす）', () => {
  const manifestPath = new URL('../../public/data/buildings/manifest.json', import.meta.url);
  test.skipIf(!existsSync(manifestPath))('区と年度が manifest.json の sources.tilesets と一致する', () => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      sources: { tilesets: { level: 'detail' | 'far'; type: 'bldg' | 'brid'; city: string; lod: number; year: number }[] };
    };
    const t = m.sources.tilesets;
    const cities = (f: (x: (typeof t)[number]) => boolean): string[] => [...new Set(t.filter(f).map((x) => x.city))].sort();
    expect(cities((x) => x.level === 'detail' && x.type === 'bldg' && x.lod === 2)).toEqual([...BUILDING_DISTRICTS.detail].sort());
    expect(cities((x) => x.type === 'brid')).toEqual([...BUILDING_DISTRICTS.bridges].sort());
    expect(cities((x) => x.level === 'far' && x.lod === 1)).toEqual([...BUILDING_DISTRICTS.far].sort());
    expect([...new Set(t.map((x) => x.year))]).toEqual([DATA_YEARS.plateauBuildings]);
  });
});

describe('facts.ts の数値は、公開しているデータ（public/data/bicycles）と一致する', () => {
  const readJson = (name: string): unknown => JSON.parse(readFileSync(`public/data/bicycles/${name}`, 'utf8'));

  interface StationJson {
    name: string;
    parked: { bicycle: number; mopedGeneral: number; mopedSpecific: number; motorcycle: number };
    occupancy: { bicycle: number };
    capacity: { bicycle: number };
    inflow: { bicycle: number };
  }
  interface RemovalJson {
    fiscalYear: number;
    removed: { total: number; bicycle: number };
    returned: { bicycle: number };
    disposed: { bicycle: number };
  }
  const stations = (readJson('stations.json') as { stations: StationJson[] }).stations;
  const removal = (readJson('timeseries.json') as { removal: { series: RemovalJson[] } }).removal.series;
  const fy = (year: number): RemovalJson => removal.find((r) => r.fiscalYear === year)!;

  test('駅別の表（都内全体、駅の数、秋葉原）', () => {
    const sum = (f: (s: StationJson) => number): number => stations.reduce((a, s) => a + f(s), 0);
    expect(sum((s) => s.parked.bicycle)).toBe(FACTS.totalParked.value);
    expect(stations.filter((s) => s.parked.bicycle > 0).length).toBe(FACTS.stationsWithParked.value);
    expect(stations.filter((s) => s.parked.bicycle >= 100).length).toBe(FACTS.stationsWithManyParked.value);
    expect(stations.filter((s) => s.parked.bicycle > 0 && s.capacity.bicycle - s.occupancy.bicycle >= s.parked.bicycle).length).toBe(
      FACTS.stationsVacancyExceeds.value,
    );
    // 1990年と同じ数え方（自転車は100台以上、原付・自二は合わせて50台以上の駅だけ）
    const oldMethod = sum((s) => {
      const mopeds = s.parked.mopedGeneral + s.parked.mopedSpecific + s.parked.motorcycle;
      return (s.parked.bicycle >= 100 ? s.parked.bicycle : 0) + (mopeds >= 50 ? mopeds : 0);
    });
    expect(oldMethod).toBe(FACTS.sameMethodParked2025.value);

    const akihabara = stations.filter((s) => s.name === '秋葉原駅');
    expect(akihabara).toHaveLength(1);
    expect(akihabara[0]!.parked.bicycle).toBe(FACTS.akihabaraParked.value);
    expect(akihabara[0]!.inflow.bicycle).toBe(FACTS.akihabaraInflow.value);
    expect(akihabara[0]!.capacity.bicycle).toBe(FACTS.akihabaraCapacity.value);
    expect(akihabara[0]!.occupancy.bicycle).toBe(FACTS.akihabaraOccupancy.value);
  });

  test('撤去・返還・処分の台数', () => {
    expect(fy(2024).removed.bicycle).toBe(FACTS.removedFY2024.value);
    expect(fy(2024).removed.total).toBe(REMOVED_FY2024_WITH_MOPEDS.value);
    expect(fy(2024).returned.bicycle).toBe(FACTS.returnedFY2024.value);
    expect(fy(2024).disposed.bicycle).toBe(FACTS.disposedFY2024.value);
    expect(fy(2010).removed.bicycle).toBe(FACTS.removedFY2010.value);
    const cumulative = removal.filter((r) => r.fiscalYear >= 2010 && r.fiscalYear <= 2024).reduce((a, r) => a + r.removed.bicycle, 0);
    expect(cumulative).toBe(FACTS.removed15Years.value);
  });
});
