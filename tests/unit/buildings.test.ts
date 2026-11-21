import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBuildingChunk, encodeBuildingChunk, isGzip, quantizeTriangles, type BuildingManifest } from '../../src/data/buildings';
import { bakedIndex, buildingSourceFromUrl, selectBakedChunks } from '../../src/scene/plateau/bakedBuildings';

/** 箱（12 三角形）の三角形の配列。 */
function box(x: number, z: number, w: number, h: number): number[] {
  const p = [
    [x, 0, z], [x + w, 0, z], [x + w, 0, z + w], [x, 0, z + w],
    [x, h, z], [x + w, h, z], [x + w, h, z + w], [x, h, z + w],
  ] as const;
  const f = [[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7], [4, 5, 6], [4, 6, 7], [0, 2, 1], [0, 3, 2]];
  return f.flatMap((t) => t.flatMap((i) => [...p[i]!]));
}

describe('建物のチャンクの形式', () => {
  it('量子化 → 符号化 → 復号で、頂点の位置が刻みの半分以内で戻り、三角形の数と群が保たれる', () => {
    const a = new Float32Array(box(100.123, -2000.456, 20, 35.5));
    const b = new Float32Array(box(130, -1990, 10, 8));
    const mesh = quantizeTriangles([a, new Float32Array(0), b], 0.01);
    expect(mesh.indices.length / 3).toBe(24);
    // 同じ位置の頂点はまとまる（箱 2 つで 16 頂点）
    expect(mesh.positions.length / 3).toBe(16);
    expect(Array.from(mesh.groups)).toEqual([0, 12, 12, 24]);
    const raw = encodeBuildingChunk(mesh);
    const back = decodeBuildingChunk(raw);
    expect(Array.from(back.positions)).toEqual(Array.from(mesh.positions));
    expect(Array.from(back.indices)).toEqual(Array.from(mesh.indices));
    expect(Array.from(back.groups)).toEqual([0, 12, 12, 24]);
    // 元の三角形の頂点と比べる
    const src = [...a, ...b];
    for (let t = 0; t < 24; t++) {
      for (let k = 0; k < 3; k++) {
        const v = back.indices[t * 3 + k]!;
        for (let c = 0; c < 3; c++) {
          const pos = back.origin[c]! + back.positions[v * 3 + c]! * back.step[c]!;
          expect(Math.abs(pos - src[(t * 3 + k) * 3 + c]!)).toBeLessThanOrEqual(back.step[c]! / 2 + 1e-3);
        }
      }
    }
  });

  it('面積のなくなった三角形は捨て、同じ入力からは同じバイト列になる', () => {
    const tris = new Float32Array([...box(0, 0, 5, 5), 0, 0, 0, 0.001, 0, 0, 0, 0, 0.001]);
    const m1 = quantizeTriangles([tris], 0.01);
    expect(m1.indices.length / 3).toBe(12);
    const e1 = encodeBuildingChunk(m1);
    const e2 = encodeBuildingChunk(quantizeTriangles([tris], 0.01));
    expect(Buffer.from(e1).equals(Buffer.from(e2))).toBe(true);
  });

  it('6 万頂点を超えると索引は 32bit になり、復号できる', () => {
    const parts: number[] = [];
    for (let i = 0; i < 9000; i++) parts.push(...box((i % 100) * 3, Math.floor(i / 100) * 3, 2, 3 + (i % 7)));
    const mesh = quantizeTriangles([new Float32Array(parts)], 0.01);
    expect(mesh.positions.length / 3).toBeGreaterThan(65535);
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    const back = decodeBuildingChunk(encodeBuildingChunk(mesh));
    expect(back.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(back.indices.subarray(-30))).toEqual(Array.from(mesh.indices.subarray(-30)));
  });

  it('gzip の先頭を見分け、壊れたデータは例外にする', () => {
    const raw = encodeBuildingChunk(quantizeTriangles([new Float32Array(box(0, 0, 1, 1))], 0.01));
    expect(isGzip(new Uint8Array(gzipSync(raw)))).toBe(true);
    expect(isGzip(raw)).toBe(false);
    expect(() => decodeBuildingChunk(new Uint8Array(10))).toThrow();
    expect(() => decodeBuildingChunk(raw.subarray(0, raw.length - 5))).toThrow();
  });
});

function manifest(): BuildingManifest {
  const chunk = (level: 'detail' | 'far', ix: number, iz: number) => ({
    level, ix, iz, path: '', bytes: 1, rawBytes: 1, sha256: '', triangles: 1, vertices: 3, features: 1, minY: 0, maxY: 1,
  });
  return {
    formatVersion: 1,
    inputHash: '',
    generatedAt: '',
    coordinates: '',
    levels: {
      detail: { chunkSizeM: 250, cellsPerSide: 1, viewDistanceM: 600, description: '' },
      far: { chunkSizeM: 1000, cellsPerSide: 4, viewDistanceM: 5000, description: '' },
    },
    places: [],
    sources: { catalog: '', tilesets: [], method: '' },
    totals: { files: 0, bytes: 0, rawBytes: 0, triangles: 0, byLevel: { detail: { files: 0, bytes: 0, rawBytes: 0, triangles: 0 }, far: { files: 0, bytes: 0, rawBytes: 0, triangles: 0 } } },
    chunks: [chunk('detail', 0, 0), chunk('far', 0, 0), chunk('far', 3, 0), chunk('far', 10, 0)],
    detailCells: ['0_0', '1_0', '8_0'],
  };
}

describe('変換済みの建物のチャンクの選び方', () => {
  it('詳細はカメラか注視点から viewDistanceM 以内の変換したセル、遠景はカメラから上限以内のチャンク', () => {
    const index = bakedIndex(manifest());
    const sel = selectBakedChunks(index, { x: 100, z: 100 }, null, 4000);
    expect([...sel.detail.keys()].sort()).toEqual(['0_0', '1_0']);
    expect([...sel.far.keys()].sort()).toEqual(['0_0', '3_0']);
    // 注視点の周りのセルも詳細にする（8_0 は x=2000〜2250）
    const withTarget = selectBakedChunks(index, { x: 100, z: 100 }, { x: 2100, z: 100 }, 4000);
    expect([...withTarget.detail.keys()].sort()).toEqual(['0_0', '1_0', '8_0']);
    // 遠景の上限は、変換した範囲（5000m）を超えない
    expect([...selectBakedChunks(index, { x: 100, z: 100 }, null, 20000).far.keys()].sort()).toEqual(['0_0', '3_0']);
    expect(selectBakedChunks(index, { x: 100, z: 100 }, null, 2000).far.has('3_0')).toBe(false);
  });

  it('URL の ?buildings=live だけで直接読む経路にする', () => {
    expect(buildingSourceFromUrl('')).toBe('baked');
    expect(buildingSourceFromUrl('?buildings=live')).toBe('live');
    expect(buildingSourceFromUrl('?buildings=baked')).toBe('baked');
  });
});
