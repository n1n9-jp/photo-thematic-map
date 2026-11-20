import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  bytesToUint16,
  cityGridFromBytes,
  dequantizeHeights,
  GRID_CLASS,
  GRID_NAMES,
  QUANT_NODATA,
  quantizeHeights,
  uint16ToBytes,
} from '../../src/data/grids';
import { readGridFiles } from '../../scripts/bake/readGrid';

describe('量子化', () => {
  test('往復の誤差は刻みの半分以下で、NaN は欠損として戻る', () => {
    const values = new Float32Array(10_000);
    for (let i = 0; i < values.length; i++) values[i] = 33.77 + ((i * 7919) % 10_007) * 0.0251;
    values[5] = Number.NaN;
    const { data, q } = quantizeHeights(values, 0.02);
    expect(q.scale).toBeLessThanOrEqual(0.05);
    expect(data[5]).toBe(QUANT_NODATA);
    const back = dequantizeHeights(bytesToUint16(uint16ToBytes(data)), q);
    let maxErr = 0;
    for (let i = 0; i < values.length; i++) {
      if (i === 5) continue;
      maxErr = Math.max(maxErr, Math.abs((back[i] as number) - (values[i] as number)));
    }
    expect(Number.isNaN(back[5] as number)).toBe(true);
    expect(maxErr).toBeLessThanOrEqual(0.01 + 1e-4);
  });

  test('範囲が広すぎると例外', () => {
    expect(() => quantizeHeights(Float32Array.from([0, 2000]), 0.02)).toThrow(RangeError);
  });

  test('バイト列はリトルエンディアン', () => {
    expect(Array.from(uint16ToBytes(Uint16Array.from([0x1234])))).toEqual([0x34, 0x12]);
  });
});

describe.each(GRID_NAMES)('格子 %s', (name) => {
  const { meta, bytes } = readGridFiles(name);
  const grid = cityGridFromBytes(meta, bytes);
  const n = meta.width * meta.height;

  test('メタ情報と配列の大きさ・ハッシュが合う', () => {
    expect(meta.name).toBe(name);
    expect(meta.cellSize).toBe(1);
    expect(bytes.height.byteLength).toBe(n * 2);
    expect(bytes.ground.byteLength).toBe(n * 2);
    expect(bytes.classes.byteLength).toBe(n);
    expect(meta.files.height.bytes).toBe(n * 2);
    const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
    expect(sha(bytes.height)).toBe(meta.files.height.sha256);
    expect(sha(bytes.ground)).toBe(meta.files.ground.sha256);
    expect(sha(bytes.classes)).toBe(meta.files.class.sha256);
    expect(meta.quantization.height.scale).toBeLessThanOrEqual(0.05);
    expect(meta.quantization.ground.scale).toBeLessThanOrEqual(0.05);
    expect(() => cityGridFromBytes(meta, { ...bytes, classes: bytes.classes.subarray(1) })).toThrow(RangeError);
  });

  test('欠損（NaN）がなく、地表は地面以上', () => {
    let nan = 0;
    let below = 0;
    for (let i = 0; i < n; i++) {
      const s = grid.surface.data[i] as number;
      const g = grid.ground.data[i] as number;
      if (Number.isNaN(s) || Number.isNaN(g)) nan++;
      else if (s < g - 1e-3) below++;
    }
    expect(nan).toBe(0);
    expect(below).toBe(0);
  });

  test('地面のないセル（分類 0・255）は地表 = 地面', () => {
    let diff = 0;
    for (let i = 0; i < n; i++) {
      const c = grid.classes[i];
      if ((c === GRID_CLASS.ground || c === GRID_CLASS.nodata) && Math.abs((grid.surface.data[i] as number) - (grid.ground.data[i] as number)) > 1e-3) diff++;
    }
    expect(diff).toBe(0);
  });

  test('分類の割合が妥当', () => {
    const count = new Map<number, number>();
    for (let i = 0; i < n; i++) count.set(grid.classes[i] as number, (count.get(grid.classes[i] as number) ?? 0) + 1);
    for (const k of count.keys()) expect(Object.values(GRID_CLASS)).toContain(k);
    const f = (c: number): number => (count.get(c) ?? 0) / n;
    expect(f(GRID_CLASS.building)).toBeGreaterThan(0.1);
    expect(f(GRID_CLASS.building)).toBeLessThan(0.6);
    expect(f(GRID_CLASS.bridge)).toBeLessThan(0.2);
    expect(f(GRID_CLASS.ground)).toBeGreaterThan(0.3);
    expect(f(GRID_CLASS.nodata)).toBeLessThan(0.15);
  });

  test('地面の高さが東京の標高として妥当（ローカル Y = 標高）', () => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of grid.ground.data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThan(-6);
    expect(max).toBeLessThan(60);
  });

  test('既知の建物: 格子の屋上がモデルの最高点と合い、公表されている高さと 6% 以内', () => {
    interface Lm {
      found: boolean;
      gridHeight?: number;
      roofY?: number;
      modelTopY?: number;
      published?: { height: number } | null;
    }
    const lms = ((meta.landmarks ?? []) as Lm[]).filter((l) => l.found);
    expect(lms.length).toBeGreaterThanOrEqual(3);
    for (const l of lms) {
      // セルの中心に掛からない細い塔屋・アンテナのぶん、格子の屋上は低くなりうる。
      const d = (l.modelTopY as number) - (l.roofY as number);
      expect(d).toBeGreaterThanOrEqual(-0.05);
      expect(d).toBeLessThan(8);
      if (l.published) expect(Math.abs((l.gridHeight as number) / l.published.height - 1)).toBeLessThan(0.06);
    }
  });
});
