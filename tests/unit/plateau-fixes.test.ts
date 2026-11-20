import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { GEOID_HEIGHT_M } from '../../src/config';
import { geodeticToEcef } from '../../src/geo/ecef';
import { latLonToLocal } from '../../src/geo/enu';
import { DEFAULT_BUDGET, SMALL_DEVICE_BUDGET, isSmallDevice, plateauMemoryBudget } from '../../src/scene/plateau/budget';
import {
  ecefToLocalMatrix,
  localToCullFrameMatrix,
  originGroupMatrix,
  readImageSize,
} from '../../src/scene/plateau/buildings';
import { GsiElevationSource } from '../../src/scene/plateau/elevation';
import { TileFetchPolicy, TileUnavailableError } from '../../src/scene/plateau/tileFetch';

const AKABANE = { lat: 35.7778, lon: 139.7209 };
const AKIHABARA = { lat: 35.69836, lon: 139.77313 };
const SHIBUYA = { lat: 35.65803, lon: 139.70165 };

/** 中心から東西南北・斜めに distM 離れた点（緯度経度の差）。 */
function around(center: { lat: number; lon: number }, distM: number): { lat: number; lon: number }[] {
  const dLat = distM / 111_000;
  const dLon = distM / (111_000 * Math.cos((center.lat * Math.PI) / 180));
  const out: { lat: number; lon: number }[] = [];
  for (const [a, b] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, -Math.SQRT1_2],
  ] as const) {
    out.push({ lat: center.lat + a * dLat, lon: center.lon + b * dLon });
  }
  return out;
}

/** タイル中心 center の行列で ECEF の点を置いたときの、latLonToLocal との最大のずれ(m)。 */
function maxError(center: { lat: number; lon: number }, distM: number, scale: boolean): number {
  const c = geodeticToEcef(center.lat, center.lon, 20 + GEOID_HEIGHT_M);
  const m = ecefToLocalMatrix(c, undefined, scale);
  let worst = 0;
  for (const p of around(center, distM)) {
    for (const h of [20, 80]) {
      const e = geodeticToEcef(p.lat, p.lon, h + GEOID_HEIGHT_M);
      const v = new Vector3(e.x, e.y, e.z).applyMatrix4(m);
      const expected = latLonToLocal({ lat: p.lat, lon: p.lon, alt: h });
      worst = Math.max(worst, Math.hypot(v.x - expected.x, v.y - expected.y, v.z - expected.z));
    }
  }
  return worst;
}

describe('ecefToLocalMatrix の縮尺（タイル内のずれ）', () => {
  it('赤羽駅付近のタイル中心から 225m の点のずれが 0.02m 未満', () => {
    expect(maxError(AKABANE, 225, true)).toBeLessThan(0.02);
  });

  it('剛体変換のままだと赤羽では 0.2m 以上ずれる（縮尺を合わせる理由）', () => {
    expect(maxError(AKABANE, 225, false)).toBeGreaterThan(0.2);
  });

  it('秋葉原・渋谷でもタイル中心から 225m の点のずれが 0.02m 未満', () => {
    expect(maxError(AKIHABARA, 225, true)).toBeLessThan(0.02);
    expect(maxError(SHIBUYA, 225, true)).toBeLessThan(0.02);
  });

  it('赤羽で隣り合うタイル（中心が 450m 離れる）の境界の点が、両方のタイルで 0.03m 以内に一致する', () => {
    const dLon = 450 / (111_000 * Math.cos((AKABANE.lat * Math.PI) / 180));
    const east = { lat: AKABANE.lat, lon: AKABANE.lon + dLon };
    const a = ecefToLocalMatrix(geodeticToEcef(AKABANE.lat, AKABANE.lon, 20 + GEOID_HEIGHT_M));
    const b = ecefToLocalMatrix(geodeticToEcef(east.lat, east.lon, 20 + GEOID_HEIGHT_M));
    const mid = geodeticToEcef(AKABANE.lat + 0.001, AKABANE.lon + dLon / 2, 30 + GEOID_HEIGHT_M);
    const pa = new Vector3(mid.x, mid.y, mid.z).applyMatrix4(a);
    const pb = new Vector3(mid.x, mid.y, mid.z).applyMatrix4(b);
    expect(pa.distanceTo(pb)).toBeLessThan(0.03);
  });
});

describe('localToCullFrameMatrix（カリング・詳細度の判定に渡すカメラの座標）', () => {
  const group = originGroupMatrix();

  /** カメラ at の近くの点 p（緯度経度・標高）について、判定の座標で見た位置と、写したカメラの座標系で見た位置の差(m)。 */
  function mismatch(at: { lat: number; lon: number; alt: number }, offsetM: number, corrected: boolean): number {
    const atLocal = latLonToLocal(at);
    const m = corrected ? localToCullFrameMatrix(new Vector3(atLocal.x, atLocal.y, atLocal.z), group) : null;
    let worst = 0;
    for (const p of around(at, offsetM)) {
      const local = latLonToLocal({ ...p, alt: at.alt });
      const e = geodeticToEcef(p.lat, p.lon, at.alt + GEOID_HEIGHT_M);
      const lib = new Vector3(e.x, e.y, e.z).applyMatrix4(group);
      const mapped = new Vector3(local.x, local.y, local.z);
      if (m) mapped.applyMatrix4(m);
      worst = Math.max(worst, lib.distanceTo(mapped));
    }
    return worst;
  }

  it('補正しないと、赤羽（原点から約 11.5km）では判定の位置が 10m 近くずれる', () => {
    expect(mismatch({ ...AKABANE, alt: 10 }, 0, false)).toBeGreaterThan(8);
  });

  it('補正すると、赤羽のカメラから 300m 以内の点が判定の座標と 0.05m 以内で一致する', () => {
    expect(mismatch({ ...AKABANE, alt: 10 }, 0, true)).toBeLessThan(0.01);
    expect(mismatch({ ...AKABANE, alt: 10 }, 300, true)).toBeLessThan(0.05);
  });

  it('原点から 60km 離れても、カメラから 500m 以内の点は 0.2m 以内で一致する', () => {
    expect(mismatch({ lat: 35.68124 + 0.54, lon: 139.76712, alt: 50 }, 500, true)).toBeLessThan(0.2);
  });
});

describe('readImageSize（復号の前に画像の大きさを読む）', () => {
  it('PNG', () => {
    const b = new Uint8Array(32);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    b.set([0, 0, 0x10, 0, 0, 0, 0x08, 0], 16); // 4096 x 2048
    expect(readImageSize(b)).toEqual({ width: 4096, height: 2048 });
  });

  it('WebP（VP8・VP8L・VP8X）', () => {
    const riff = (chunk: string, body: number[]): Uint8Array => {
      const b = new Uint8Array(40);
      b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
      b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
      b.set([...chunk].map((c) => c.charCodeAt(0)), 12);
      b.set(body, 20);
      return b;
    };
    // VP8: フレームヘッダー（3 バイト）・開始コード（3 バイト）の後に幅・高さ（14 ビット、リトルエンディアン）
    expect(readImageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x10, 0x00, 0x08]))).toEqual({
      width: 4096,
      height: 2048,
    });
    // VP8L: 0x2f の後に 14 ビットずつ (幅-1)・(高さ-1)
    const w = 4095;
    const h = 1023;
    const bits = w | (h << 14);
    expect(readImageSize(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]))).toEqual({
      width: 4096,
      height: 1024,
    });
    // VP8X: 4 バイトのフラグの後に 24 ビットずつ (幅-1)・(高さ-1)
    expect(readImageSize(riff('VP8X', [0, 0, 0, 0, 0xff, 0x0f, 0x00, 0xff, 0x07, 0x00]))).toEqual({
      width: 4096,
      height: 2048,
    });
  });

  it('JPEG（APP0 の後の SOF0）', () => {
    const b = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x08, 0x00, 0x10, 0x00, 0x03, 0, 0, 0, 0,
    ]);
    expect(readImageSize(b)).toEqual({ width: 4096, height: 2048 });
  });

  it('知らない形式は null', () => {
    expect(readImageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('TileFetchPolicy（再試行と遮断）', () => {
  const failing = (): { calls: number; fetch: typeof fetch } => {
    const state = { calls: 0, fetch: (() => Promise.resolve()) as unknown as typeof fetch };
    state.fetch = (() => {
      state.calls++;
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as typeof fetch;
    return state;
  };

  it('失敗したら上限の回数まで再試行し、取得不能を投げる', async () => {
    const f = failing();
    const policy = new TileFetchPolicy('テスト', { maxAttempts: 3, baseDelayMs: 1, breakerThreshold: 100 }, f.fetch);
    await expect(policy.fetch('https://example.invalid/a')).rejects.toBeInstanceOf(TileUnavailableError);
    expect(f.calls).toBe(3);
    expect(policy.failedCount).toBe(1);
  });

  it('404 は再試行せず null（存在しない）', async () => {
    let calls = 0;
    const policy = new TileFetchPolicy('テスト', { baseDelayMs: 1 }, (() => {
      calls++;
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch);
    expect(await policy.fetch('https://example.invalid/a')).toBeNull();
    expect(calls).toBe(1);
    expect(policy.failedCount).toBe(0);
  });

  it('503 の後に成功すれば Response を返す', async () => {
    let calls = 0;
    const policy = new TileFetchPolicy('テスト', { baseDelayMs: 1 }, (() => {
      calls++;
      return Promise.resolve(new Response('ok', { status: calls === 1 ? 503 : 200 }));
    }) as typeof fetch);
    const res = await policy.fetch('https://example.invalid/a');
    expect(res?.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('失敗が続いたら要求を止め、止めている間は要求を出さずに取得不能にする', async () => {
    const f = failing();
    const policy = new TileFetchPolicy(
      'テスト',
      { maxAttempts: 3, baseDelayMs: 1, breakerThreshold: 6, breakerCooldownMs: 60_000 },
      f.fetch,
    );
    for (let i = 0; i < 10; i++) {
      await expect(policy.fetch(`https://example.invalid/${i}`)).rejects.toBeInstanceOf(TileUnavailableError);
    }
    // 2 タイル × 3 回で止まり、残りの 8 タイルは要求しない
    expect(f.calls).toBe(6);
    expect(policy.failedCount).toBe(10);
    expect(policy.blocked).toBe(true);
    policy.reset();
    expect(policy.blocked).toBe(false);
  });

  it('同時に多くのタイルが失敗しても、要求は 1 巡目と少しで止まる', async () => {
    const f = failing();
    const policy = new TileFetchPolicy('テスト', { maxAttempts: 3, baseDelayMs: 5, breakerThreshold: 6 }, f.fetch);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => policy.fetch(`https://example.invalid/${i}`)),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(f.calls).toBe(25);
  });
});

describe('GsiElevationSource のキャッシュ', () => {
  it('上限を超えたら古いタイルから外し、取得できなかったタイルは null として覚える', async () => {
    const calls: string[] = [];
    const policy = new TileFetchPolicy('標高', { maxAttempts: 1, breakerThreshold: 1000 }, ((url: string) => {
      calls.push(url);
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch);
    const source = new GsiElevationSource({ maxTiles: 2, policy });
    expect(await source.getTile('dem10', 14, 1, 1)).toBeNull();
    expect(await source.getTile('dem10', 14, 1, 1)).toBeNull();
    expect(calls.length).toBe(1);
    await source.getTile('dem10', 14, 1, 2);
    await source.getTile('dem10', 14, 1, 3);
    expect(source.size).toBe(2);
    expect(source.failedTileCount).toBe(3);
    // 外れたタイルは取り直す
    await source.getTile('dem10', 14, 1, 1);
    expect(calls.length).toBe(4);
    source.dispose();
    expect(source.size).toBe(0);
  });

  it('標高タイルを取得できなくても elevationAt は 0 を返す', async () => {
    const policy = new TileFetchPolicy('標高', { maxAttempts: 1 }, (() =>
      Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch);
    const source = new GsiElevationSource({ maxTiles: 4, policy });
    expect(await source.elevationAt(35.68, 139.76)).toBe(0);
  });
});

describe('plateauMemoryBudget（端末に合わせたメモリの上限）', () => {
  it('メモリ 4GB 以下、または画面の短辺が 600px 以下ならスマートフォン向け', () => {
    expect(isSmallDevice({ deviceMemoryGB: 4, screenShortSide: 1080 })).toBe(true);
    expect(isSmallDevice({ screenShortSide: 390 })).toBe(true);
    expect(isSmallDevice({ deviceMemoryGB: 8, screenShortSide: 1080 })).toBe(false);
    expect(isSmallDevice({})).toBe(false);
    expect(plateauMemoryBudget({ screenShortSide: 390 })).toBe(SMALL_DEVICE_BUDGET);
    expect(plateauMemoryBudget({ deviceMemoryGB: 8, screenShortSide: 1080 })).toBe(DEFAULT_BUDGET);
  });

  it('スマートフォン向けはどの上限もパソコン向けより小さい', () => {
    expect(SMALL_DEVICE_BUDGET.buildingCache.maxBytes).toBeLessThan(DEFAULT_BUDGET.buildingCache.maxBytes);
    expect(SMALL_DEVICE_BUDGET.groundMaxTiles).toBeLessThan(DEFAULT_BUDGET.groundMaxTiles);
    expect(SMALL_DEVICE_BUDGET.elevationMaxTiles).toBeLessThan(DEFAULT_BUDGET.elevationMaxTiles);
    expect(SMALL_DEVICE_BUDGET.maxTextureSize).toBeLessThan(DEFAULT_BUDGET.maxTextureSize);
  });
});
