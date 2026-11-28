import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { GEOID_HEIGHT_M, ORIGIN } from '../../src/config';
import { ecefToGeodetic, enuBasis, geodeticToEcef } from '../../src/geo/ecef';
import { latLonToLocal } from '../../src/geo/enu';
import {
  decodeGsiDemPixel,
  latToTileY,
  lonToTileX,
  tileBounds,
  tileXToLon,
  tileYToLat,
} from '../../src/geo/tiles';
import { ecefToLocalMatrix } from '../../src/scene/plateau/buildings';
import { selectTilesets } from '../../src/scene/plateau/catalog';
import type { PlateauCatalog } from '../../src/scene/plateau/catalog';
import { decodeDemPixels, hasValidHeights, sampleDem, sampleDemAt } from '../../src/scene/plateau/elevation';
import type { DemTile } from '../../src/scene/plateau/elevation';
import { quadrantsWithAlpha } from '../../src/scene/plateau/ground';

const SHIBUYA = { lat: 35.65803, lon: 139.70165 };

describe('ecef', () => {
  it('楕円体座標 → ECEF → 楕円体座標の往復が 1mm 以内', () => {
    for (const p of [
      { lat: ORIGIN.lat, lon: ORIGIN.lon, height: 36.7 },
      { lat: SHIBUYA.lat, lon: SHIBUYA.lon, height: 300 },
      { lat: 0, lon: 0, height: 0 },
      { lat: -33.9, lon: 151.2, height: 1000 },
    ]) {
      const e = geodeticToEcef(p.lat, p.lon, p.height);
      const g = ecefToGeodetic(e);
      expect(Math.abs(g.lat - p.lat) * 111_000).toBeLessThan(0.001);
      expect(Math.abs(g.lon - p.lon) * 111_000).toBeLessThan(0.001);
      expect(Math.abs(g.height - p.height)).toBeLessThan(0.001);
    }
  });

  it('ENU 基底は正規直交', () => {
    const { east, north, up } = enuBasis(ORIGIN.lat, ORIGIN.lon);
    const dot = (a: typeof east, b: typeof east): number => a.x * b.x + a.y * b.y + a.z * b.z;
    expect(dot(east, north)).toBeCloseTo(0, 12);
    expect(dot(east, up)).toBeCloseTo(0, 12);
    expect(dot(north, up)).toBeCloseTo(0, 12);
    expect(dot(up, up)).toBeCloseTo(1, 12);
  });
});

describe('ecefToLocalMatrix（3D Tiles をローカル座標に置く変換）', () => {
  it('原点の楕円体高 = ジオイド高 の点がローカル (0,0,0) に写る', () => {
    const c = geodeticToEcef(ORIGIN.lat, ORIGIN.lon, GEOID_HEIGHT_M);
    const m = ecefToLocalMatrix(c);
    const v = new Vector3(c.x, c.y, c.z).applyMatrix4(m);
    expect(v.length()).toBeLessThan(0.001);
  });

  it('渋谷付近のタイル中心を基準にすると、周囲 100m の点が latLonToLocal と 5cm 以内で一致する（局所近似の縮尺差ぶん）', () => {
    const c = geodeticToEcef(SHIBUYA.lat, SHIBUYA.lon, 20 + GEOID_HEIGHT_M);
    const m = ecefToLocalMatrix(c);
    for (const [dLat, dLon, h] of [
      [0.0009, 0, 20],
      [0, 0.0011, 20],
      [-0.0009, -0.0011, 80],
    ] as const) {
      const lat = SHIBUYA.lat + dLat;
      const lon = SHIBUYA.lon + dLon;
      const e = geodeticToEcef(lat, lon, h + GEOID_HEIGHT_M);
      const v = new Vector3(e.x, e.y, e.z).applyMatrix4(m);
      const expected = latLonToLocal({ lat, lon, alt: h });
      expect(Math.hypot(v.x - expected.x, v.y - expected.y, v.z - expected.z)).toBeLessThan(0.05);
    }
  });

  it('原点の剛体変換だけで渋谷を置くと地球の丸みで数 m 下がる（タイルごとに置き直す理由）', () => {
    const m = ecefToLocalMatrix(geodeticToEcef(ORIGIN.lat, ORIGIN.lon, GEOID_HEIGHT_M));
    const e = geodeticToEcef(SHIBUYA.lat, SHIBUYA.lon, GEOID_HEIGHT_M);
    const v = new Vector3(e.x, e.y, e.z).applyMatrix4(m);
    expect(v.y).toBeLessThan(-2);
  });
});

describe('XYZ タイル', () => {
  it('東京駅を含むズーム19のタイル範囲に東京駅が入る', () => {
    const z = 19;
    const x = Math.floor(lonToTileX(ORIGIN.lon, z));
    const y = Math.floor(latToTileY(ORIGIN.lat, z));
    const b = tileBounds(z, x, y);
    expect(ORIGIN.lon).toBeGreaterThanOrEqual(b.west);
    expect(ORIGIN.lon).toBeLessThan(b.east);
    expect(ORIGIN.lat).toBeLessThanOrEqual(b.north);
    expect(ORIGIN.lat).toBeGreaterThan(b.south);
  });

  it('タイル座標と緯度経度の往復', () => {
    for (const z of [0, 10, 15, 19]) {
      expect(tileXToLon(lonToTileX(SHIBUYA.lon, z), z)).toBeCloseTo(SHIBUYA.lon, 9);
      expect(tileYToLat(latToTileY(SHIBUYA.lat, z), z)).toBeCloseTo(SHIBUYA.lat, 9);
    }
  });
});

describe('国土地理院 標高タイル', () => {
  it('画素値を仕様どおりに復号する', () => {
    expect(decodeGsiDemPixel(0, 0, 0)).toBe(0);
    expect(decodeGsiDemPixel(0, 0x01, 0x2c)).toBeCloseTo(3.0, 9); // 300 * 0.01
    expect(decodeGsiDemPixel(0x80, 0, 0)).toBeNull();
    expect(decodeGsiDemPixel(0xff, 0xff, 0xff)).toBeCloseTo(-0.01, 9);
  });

  const tile = (fill: (x: number, y: number) => [number, number, number]): DemTile => {
    const px = new Uint8ClampedArray(256 * 256 * 4);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const [r, g, b] = fill(x, y);
        px.set([r, g, b, 255], (y * 256 + x) * 4);
      }
    }
    return { kind: 'dem5a', z: 15, x: 29105, y: 12903, heights: decodeDemPixels(px) };
  };

  it('双線形補間と無効値の扱い', () => {
    // 標高 = x * 0.01 m の傾斜
    const t = tile((x) => [0, 0, x]);
    expect(sampleDem(t, 10.5, 3.5)).toBeCloseTo(0.1, 6);
    expect(sampleDem(t, 11, 3.5)).toBeCloseTo(0.105, 6);
    const half = tile((x) => (x < 128 ? [0x80, 0, 0] : [0, 0, 100]));
    expect(hasValidHeights(half, 0, 0, 128, 256)).toBe(false);
    expect(hasValidHeights(half, 128, 0, 256, 256)).toBe(true);
    expect(Number.isNaN(sampleDem(half, 10, 10))).toBe(true);
    expect(sampleDem(half, 200, 10)).toBeCloseTo(1, 6);
  });

  it('タイル外の緯度経度は NaN', () => {
    const t = tile(() => [0, 0, 100]);
    expect(Number.isNaN(sampleDemAt(t, 0, 0))).toBe(true);
  });
});

describe('地面の子タイルの有無（陸の範囲）', () => {
  it('不透明な画素がある象限だけ true', () => {
    const w = 4;
    const px = new Uint8ClampedArray(w * w * 4);
    px[(0 * w + 3) * 4 + 3] = 255; // 北東
    px[(3 * w + 0) * 4 + 3] = 10; // 南西
    expect(quadrantsWithAlpha(px, w, w)).toEqual([false, true, true, false]);
  });
});

describe('selectTilesets', () => {
  const catalog: PlateauCatalog = {
    source: '',
    attribution: '',
    year: 2025,
    generatedAt: '',
    wards: [
      {
        code: '13101',
        name: '千代田区',
        year: 2025,
        bounds: { west: 139.73, south: 35.669, east: 139.7828, north: 35.7052, minHeight: 0, maxHeight: 0 },
        tilesets: { lod2_texture: 'chiyoda-tex', lod2_no_texture: 'chiyoda-notex', lod1: 'chiyoda-lod1' },
      },
      {
        code: '13113',
        name: '渋谷区',
        year: 2025,
        bounds: { west: 139.66, south: 35.64, east: 139.72, north: 35.69, minHeight: 0, maxHeight: 0 },
        tilesets: { lod1: 'shibuya-lod1' },
      },
    ],
  };

  it('範囲に掛かる区だけ、指定の種類で返す', () => {
    expect(selectTilesets(catalog, ORIGIN.lat, ORIGIN.lon, 300)).toEqual(['chiyoda-tex']);
    expect(selectTilesets(catalog, ORIGIN.lat, ORIGIN.lon, 300, 'lod2_no_texture')).toEqual(['chiyoda-notex']);
  });

  it('指定の種類が無い区は代わりを使う', () => {
    expect(selectTilesets(catalog, SHIBUYA.lat, SHIBUYA.lon, 300)).toEqual(['shibuya-lod1']);
  });
});
