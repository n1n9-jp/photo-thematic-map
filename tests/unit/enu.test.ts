import { describe, expect, it } from 'vitest';
import { ORIGIN } from '../../src/config';
import { ecefToLocalMatrix, ecefToTangentMatrix, geodeticToEcef, latLonToLocal, localToLatLon } from '../../src/geo/enu';

describe('enu', () => {
  it('原点はローカル(0,0,0)に写る', () => {
    const v = latLonToLocal(ORIGIN);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(0, 9);
  });

  it('東京タワーは原点から南西へ約3.2kmに来る（X<0 西, Z>0 南）', () => {
    const v = latLonToLocal({ lat: 35.65858, lon: 139.74543 });
    expect(v.x).toBeLessThan(0);
    expect(v.z).toBeGreaterThan(0);
    const dist = Math.hypot(v.x, v.z);
    expect(dist).toBeGreaterThan(3100);
    expect(dist).toBeLessThan(3300);
    // 南西方向: 西成分・南成分とも 1.5km〜2.5km 程度
    expect(Math.abs(v.x)).toBeGreaterThan(1500);
    expect(v.z).toBeGreaterThan(2000);
  });

  it('北へ行くと -Z、東へ行くと +X、高さは +Y', () => {
    const n = latLonToLocal({ lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon });
    expect(n.z).toBeLessThan(0);
    const e = latLonToLocal({ lat: ORIGIN.lat, lon: ORIGIN.lon + 0.001 });
    expect(e.x).toBeGreaterThan(0);
    const u = latLonToLocal({ lat: ORIGIN.lat, lon: ORIGIN.lon, alt: 100 });
    expect(u.y).toBeCloseTo(100, 6);
  });

  it('緯度1度は約111km、経度1度は約90km（東京付近）', () => {
    const dLat = latLonToLocal({ lat: ORIGIN.lat + 1, lon: ORIGIN.lon });
    expect(Math.abs(dLat.z)).toBeGreaterThan(110_500);
    expect(Math.abs(dLat.z)).toBeLessThan(111_500);
    const dLon = latLonToLocal({ lat: ORIGIN.lat, lon: ORIGIN.lon + 1 });
    expect(dLon.x).toBeGreaterThan(90_000);
    expect(dLon.x).toBeLessThan(91_500);
  });

  it('往復変換の誤差が1cm以内（原点から±30km 格子）', () => {
    const delta = [-0.3, -0.1, 0, 0.1, 0.3];
    for (const dLat of delta) {
      for (const dLon of delta) {
        const p = { lat: ORIGIN.lat + dLat, lon: ORIGIN.lon + dLon, alt: 250 };
        const back = localToLatLon(latLonToLocal(p));
        const again = latLonToLocal(back);
        const orig = latLonToLocal(p);
        expect(Math.hypot(again.x - orig.x, again.y - orig.y, again.z - orig.z)).toBeLessThan(0.01);
        expect(back.alt).toBeCloseTo(250, 6);
      }
    }
  });

  it('逆方向の往復（ローカル→緯度経度→ローカル）も1cm以内', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 1234.5, y: 56.7, z: -890.1 },
      { x: -2500, y: 10, z: 3200 },
      { x: 20000, y: 300, z: -15000 },
    ];
    for (const v of pts) {
      const back = latLonToLocal(localToLatLon(v));
      expect(Math.hypot(back.x - v.x, back.y - v.y, back.z - v.z)).toBeLessThan(0.01);
    }
  });

  it('平らな地図なので、同じ標高なら原点から離れても Y は変わらない', () => {
    const v = latLonToLocal({ lat: ORIGIN.lat + 0.18, lon: ORIGIN.lon - 0.2, alt: 12.5 });
    expect(v.y).toBeCloseTo(12.5, 9);
  });

  it('厳密な ENU 行列は、原点の近く（東京タワー、約3.2km）で平らな地図と水平 1m 以内で一致する', () => {
    const m = ecefToTangentMatrix();
    const p = { lat: 35.65858, lon: 139.74543, alt: 0 };
    const [ex, ey, ez] = geodeticToEcef(p);
    const x = m[0]! * ex + m[1]! * ey + m[2]! * ez + m[3]!;
    const y = m[4]! * ex + m[5]! * ey + m[6]! * ez + m[7]!;
    const z = m[8]! * ex + m[9]! * ey + m[10]! * ez + m[11]!;
    const v = latLonToLocal(p);
    expect(Math.hypot(x - v.x, z - v.z)).toBeLessThan(1);
    // 厳密な ENU では、丸みのぶんだけ Y が下がる（3.2km で約 0.8m）
    const d = Math.hypot(v.x, v.z);
    expect(y).toBeCloseTo(-(d * d) / (2 * 6_371_000), 0);
  });
});

describe('ecefToLocalMatrix（非推奨の別名）', () => {
  it('ecefToTangentMatrix と同じ関数', () => {
    expect(ecefToLocalMatrix).toBe(ecefToTangentMatrix);
  });
});
