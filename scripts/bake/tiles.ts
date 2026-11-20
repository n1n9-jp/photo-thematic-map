/**
 * 3D Tiles 1.0（b3dm）の読み込み。
 *
 * - タイルセットをたどり、範囲（緯度経度）にかかる「子を持たないタイル」（最も細かい詳細度）を選ぶ。
 *   PLATEAU のタイルセットは refine: REPLACE で、葉のタイルの集合が全建物を重複なく含む。
 * - b3dm の glTF（KHR_draco_mesh_compression・CESIUM_RTC）を復号し、三角形を ECEF で返す。
 *   Draco の復号には three 同梱の `draco_decoder.js`（Emscripten の JS 版）を Node の vm で動かす。
 * - glTF は Y-up なので、3D Tiles 1.0 の規約どおり Y-up → Z-up の回転をかけてから RTC の中心を足す。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { fetchCached, fetchJsonCached } from './cache';

/* eslint-disable @typescript-eslint/no-explicit-any -- Emscripten のモジュールと glTF の JSON は型を持たない */

export interface TileJson {
  boundingVolume: { region?: number[]; box?: number[]; sphere?: number[] };
  geometricError: number;
  refine?: 'ADD' | 'REPLACE';
  transform?: number[];
  content?: { uri?: string; url?: string };
  children?: TileJson[];
}

export interface TilesetJson {
  asset: { version: string };
  root: TileJson;
}

/** 緯度経度の範囲（ラジアン）。 */
export interface RegionRad {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SelectedTile {
  url: string;
  geometricError: number;
  depth: number;
}

/** 範囲にかかる葉のタイル（内容を持つもの）の URL。 */
export async function selectLeafTiles(tilesetUrl: string, area: RegionRad): Promise<{ tiles: SelectedTile[]; maxDepth: number; total: number }> {
  const ts = await fetchJsonCached<TilesetJson>(tilesetUrl);
  if (!ts.asset.version.startsWith('1.')) throw new Error(`未対応の 3D Tiles の版です: ${ts.asset.version}`);
  const tiles: SelectedTile[] = [];
  let maxDepth = 0;
  let total = 0;
  const walk = (t: TileJson, depth: number, base: string): void => {
    total++;
    if (t.transform) throw new Error('タイルの transform には未対応です');
    const r = t.boundingVolume.region;
    if (!r) throw new Error('region 以外の boundingVolume には未対応です');
    const [w, s, e, n] = r as [number, number, number, number];
    if (e < area.west || w > area.east || n < area.south || s > area.north) return;
    maxDepth = Math.max(maxDepth, depth);
    const uri = t.content?.uri ?? t.content?.url;
    if (uri && uri.endsWith('.json')) throw new Error('外部タイルセットには未対応です');
    if (!t.children || t.children.length === 0) {
      if (uri) tiles.push({ url: new URL(uri, base).href, geometricError: t.geometricError, depth });
      return;
    }
    if (t.refine && t.refine !== 'REPLACE') throw new Error('refine: ADD には未対応です');
    for (const c of t.children) walk(c, depth + 1, base);
  };
  walk(ts.root, 0, tilesetUrl);
  return { tiles, maxDepth, total };
}

// ---------------------------------------------------------------------------
// Draco
// ---------------------------------------------------------------------------

let dracoModule: Promise<any> | null = null;
function draco(): Promise<any> {
  if (!dracoModule) {
    const require = createRequire(import.meta.url);
    const file = require.resolve('three/examples/jsm/libs/draco/draco_decoder.js');
    const ctx: any = { module: { exports: {} }, console };
    ctx.exports = ctx.module.exports;
    createContext(ctx);
    runInContext(`${readFileSync(file, 'utf8')}\nmodule.exports = DracoDecoderModule;`, ctx, { filename: file });
    dracoModule = ctx.module.exports({});
  }
  return dracoModule as Promise<any>;
}

interface DecodedPrimitive {
  positions: Float32Array;
  indices: Uint32Array;
  batchIds: Float32Array | null;
}

async function decodeDraco(data: Uint8Array, attrs: Record<string, number>): Promise<DecodedPrimitive> {
  const M = await draco();
  const decoder = new M.Decoder();
  const buffer = new M.DecoderBuffer();
  buffer.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
  const type = decoder.GetEncodedGeometryType(buffer);
  if (type !== M.TRIANGULAR_MESH) throw new Error('Draco の点群には未対応です');
  const mesh = new M.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok() || mesh.ptr === 0) throw new Error(`Draco の復号に失敗しました: ${status.error_msg()}`);
  const numPoints = mesh.num_points();
  const numFaces = mesh.num_faces();
  const readAttr = (id: number, comps: number): Float32Array => {
    const att = decoder.GetAttributeByUniqueId(mesh, id);
    const n = numPoints * comps;
    const ptr = M._malloc(n * 4);
    decoder.GetAttributeDataArrayForAllPoints(mesh, att, M.DT_FLOAT32, n * 4, ptr);
    const out = new Float32Array(M.HEAPF32.buffer, ptr, n).slice();
    M._free(ptr);
    return out;
  };
  const positions = readAttr(attrs.POSITION as number, 3);
  const idAttr = attrs._BATCHID ?? attrs._FEATURE_ID_0;
  const batchIds = idAttr !== undefined ? readAttr(idAttr, 1) : null;
  const ptr = M._malloc(numFaces * 12);
  decoder.GetTrianglesUInt32Array(mesh, numFaces * 12, ptr);
  const indices = new Uint32Array(M.HEAPF32.buffer, ptr, numFaces * 3).slice();
  M._free(ptr);
  M.destroy(mesh);
  M.destroy(buffer);
  M.destroy(decoder);
  return { positions, indices, batchIds };
}

// ---------------------------------------------------------------------------
// b3dm / glTF
// ---------------------------------------------------------------------------

export interface DecodedTile {
  /** 三角形の頂点（ECEF, m）。9 要素で 1 三角形。 */
  triangles: Float64Array;
  /** 三角形ごとの地物の番号（バッチ ID）。 */
  batchIds: Uint32Array;
  /** バッチテーブル（地物ごとの属性。JSON 部と二進部を展開済み）。 */
  batch: Record<string, unknown[]>;
  batchLength: number;
  extensions: string[];
}

const COMPONENT: Record<number, { size: number; read: (v: DataView, o: number) => number }> = {
  5120: { size: 1, read: (v, o) => v.getInt8(o) },
  5121: { size: 1, read: (v, o) => v.getUint8(o) },
  5122: { size: 2, read: (v, o) => v.getInt16(o, true) },
  5123: { size: 2, read: (v, o) => v.getUint16(o, true) },
  5125: { size: 4, read: (v, o) => v.getUint32(o, true) },
  5126: { size: 4, read: (v, o) => v.getFloat32(o, true) },
};
const TYPE_COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(gltf: any, bin: Uint8Array, index: number): Float64Array {
  const acc = gltf.accessors[index];
  const bv = gltf.bufferViews[acc.bufferView];
  const comp = COMPONENT[acc.componentType];
  if (!comp) throw new Error(`未対応の componentType ${acc.componentType}`);
  const n = TYPE_COMPS[acc.type] as number;
  const stride = bv.byteStride ?? comp.size * n;
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Float64Array(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < n; k++) out[i * n + k] = comp.read(view, base + i * stride + k * comp.size);
  }
  return out;
}

const BT_COMPONENT: Record<string, { size: number; read: (v: DataView, o: number) => number }> = {
  BYTE: { size: 1, read: (v, o) => v.getInt8(o) },
  UNSIGNED_BYTE: { size: 1, read: (v, o) => v.getUint8(o) },
  SHORT: { size: 2, read: (v, o) => v.getInt16(o, true) },
  UNSIGNED_SHORT: { size: 2, read: (v, o) => v.getUint16(o, true) },
  INT: { size: 4, read: (v, o) => v.getInt32(o, true) },
  UNSIGNED_INT: { size: 4, read: (v, o) => v.getUint32(o, true) },
  FLOAT: { size: 4, read: (v, o) => v.getFloat32(o, true) },
  DOUBLE: { size: 8, read: (v, o) => v.getFloat64(o, true) },
};

function mat4Mul(a: number[], b: number[]): number[] {
  // 列優先の 4x4 の積 a·b。
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function nodeMatrix(node: any): number[] {
  if (node.matrix) return node.matrix as number[];
  const t = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** b3dm を復号する。 */
export async function decodeB3dm(buf: Uint8Array): Promise<DecodedTile> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(...buf.subarray(0, 4));
  if (magic !== 'b3dm') throw new Error(`b3dm ではありません（${magic}）`);
  const ftJson = view.getUint32(12, true);
  const ftBin = view.getUint32(16, true);
  const btJson = view.getUint32(20, true);
  const btBin = view.getUint32(24, true);
  const td = new TextDecoder();
  let o = 28;
  const ft = ftJson > 0 ? JSON.parse(td.decode(buf.subarray(o, o + ftJson))) : {};
  o += ftJson + ftBin;
  const btj = btJson > 0 ? JSON.parse(td.decode(buf.subarray(o, o + btJson))) : {};
  const btb = buf.subarray(o + btJson, o + btJson + btBin);
  o += btJson + btBin;
  const batchLength: number = ft.BATCH_LENGTH ?? 0;
  const batch: Record<string, unknown[]> = {};
  const btv = new DataView(btb.buffer, btb.byteOffset, btb.byteLength);
  for (const [k, v] of Object.entries(btj)) {
    if (Array.isArray(v)) batch[k] = v;
    else if (v && typeof v === 'object' && 'byteOffset' in v) {
      const d = v as { byteOffset: number; componentType: string; type: string };
      const comp = BT_COMPONENT[d.componentType];
      if (!comp || d.type !== 'SCALAR') continue;
      batch[k] = Array.from({ length: batchLength }, (_, i) => comp.read(btv, d.byteOffset + i * comp.size));
    }
  }
  if (ft.RTC_CENTER) throw new Error('フィーチャーテーブルの RTC_CENTER には未対応です');

  return decodeGlb(buf.subarray(o), batch, batchLength);
}

/**
 * EXT_structural_metadata のプロパティテーブル（最初のもの）を地物ごとの属性の配列に展開する。
 * 文字列と SCALAR のみ。noData は null。
 */
function readPropertyTable(gltf: any, bin: Uint8Array): { batch: Record<string, unknown[]>; count: number } {
  const meta = gltf.extensions?.EXT_structural_metadata;
  const table = meta?.propertyTables?.[0];
  if (!table) return { batch: {}, count: 0 };
  const cls = meta.schema?.classes?.[table.class]?.properties ?? {};
  const count: number = table.count;
  const td = new TextDecoder();
  const batch: Record<string, unknown[]> = {};
  const viewOf = (bvIndex: number): DataView => {
    const bv = gltf.bufferViews[bvIndex];
    return new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
  };
  const SC: Record<string, { size: number; read: (v: DataView, o: number) => number }> = {
    INT8: { size: 1, read: (v, o) => v.getInt8(o) },
    UINT8: { size: 1, read: (v, o) => v.getUint8(o) },
    INT16: { size: 2, read: (v, o) => v.getInt16(o, true) },
    UINT16: { size: 2, read: (v, o) => v.getUint16(o, true) },
    INT32: { size: 4, read: (v, o) => v.getInt32(o, true) },
    UINT32: { size: 4, read: (v, o) => v.getUint32(o, true) },
    FLOAT32: { size: 4, read: (v, o) => v.getFloat32(o, true) },
    FLOAT64: { size: 8, read: (v, o) => v.getFloat64(o, true) },
  };
  for (const [name, prop] of Object.entries<any>(table.properties ?? {})) {
    const def = cls[name];
    if (!def || def.array) continue;
    if (def.type === 'STRING') {
      const values = viewOf(prop.values);
      const offs = viewOf(prop.stringOffsets);
      const ot = SC[prop.stringOffsetType ?? 'UINT32'] as { size: number; read: (v: DataView, o: number) => number };
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const a = ot.read(offs, i * ot.size);
        const b = ot.read(offs, (i + 1) * ot.size);
        const str = td.decode(new Uint8Array(values.buffer, values.byteOffset + a, b - a));
        out.push(def.noData !== undefined && str === def.noData ? null : str);
      }
      batch[name] = out;
    } else if (def.type === 'SCALAR') {
      const comp = SC[def.componentType];
      if (!comp) continue;
      const values = viewOf(prop.values);
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const v = comp.read(values, i * comp.size);
        out.push(def.noData !== undefined && v === def.noData ? null : v);
      }
      batch[name] = out;
    }
  }
  return { batch, count };
}

/** glb を復号する。b3dm の中身の場合はバッチテーブルを渡す。3D Tiles 1.1 の glb は EXT_structural_metadata から読む。 */
export async function decodeGlb(glb: Uint8Array, b3dmBatch: Record<string, unknown[]> | null, b3dmBatchLength: number): Promise<DecodedTile> {
  const td = new TextDecoder();
  const gv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (String.fromCharCode(...glb.subarray(0, 4)) !== 'glTF' || gv.getUint32(4, true) !== 2) throw new Error('glTF 2.0 の glb ではありません');
  const jsonLen = gv.getUint32(12, true);
  const gltf = JSON.parse(td.decode(glb.subarray(20, 20 + jsonLen)));
  const binOff = 20 + jsonLen;
  const bin = binOff + 8 <= glb.byteLength ? glb.subarray(binOff + 8, binOff + 8 + gv.getUint32(binOff, true)) : new Uint8Array(0);
  const extensions: string[] = gltf.extensionsUsed ?? [];
  let batch: Record<string, unknown[]>;
  let batchLength: number;
  if (b3dmBatch) {
    batch = b3dmBatch;
    batchLength = b3dmBatchLength;
  } else {
    const pt = readPropertyTable(gltf, bin);
    batch = pt.batch;
    batchLength = pt.count;
  }
  for (const e of gltf.extensionsRequired ?? []) {
    // 形に関わらない拡張（テクスチャ・材質）は無視してよい。
    const ok = e === 'CESIUM_RTC' || e === 'EXT_mesh_features' || e === 'EXT_structural_metadata' || e === 'KHR_draco_mesh_compression' || e.startsWith('KHR_materials_') || e.startsWith('KHR_texture_') || e.startsWith('EXT_texture_');
    if (!ok) {
      throw new Error(`未対応の必須拡張 ${e}`);
    }
  }
  const rtc: number[] = gltf.extensions?.CESIUM_RTC?.center ?? [0, 0, 0];

  const tris: number[][] = [];
  const ids: number[][] = [];
  const visit = async (nodeIndex: number, parent: number[]): Promise<void> => {
    const node = gltf.nodes[nodeIndex];
    const m = mat4Mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        let positions: ArrayLike<number>;
        let indices: ArrayLike<number> | null;
        let batchIds: ArrayLike<number> | null;
        const dr = prim.extensions?.KHR_draco_mesh_compression;
        if (dr) {
          const bv = gltf.bufferViews[dr.bufferView];
          const d = await decodeDraco(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength), dr.attributes);
          positions = d.positions;
          indices = d.indices;
          batchIds = d.batchIds;
        } else {
          positions = readAccessor(gltf, bin, prim.attributes.POSITION);
          indices = prim.indices !== undefined ? readAccessor(gltf, bin, prim.indices) : null;
          const idAcc = prim.attributes._BATCHID ?? prim.attributes._FEATURE_ID_0;
          batchIds = idAcc !== undefined ? readAccessor(gltf, bin, idAcc) : null;
        }
        const nTri = indices ? indices.length / 3 : positions.length / 9;
        const out = new Array<number>(nTri * 9);
        const idOut = new Array<number>(nTri);
        for (let t = 0; t < nTri; t++) {
          for (let k = 0; k < 3; k++) {
            const vi = indices ? (indices[t * 3 + k] as number) : t * 3 + k;
            const x = positions[vi * 3] as number;
            const y = positions[vi * 3 + 1] as number;
            const z = positions[vi * 3 + 2] as number;
            // ノードの行列（列優先）
            const gx = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
            const gy = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
            const gz = (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
            // Y-up → Z-up（x, y, z）→（x, −z, y）、続いて RTC の中心。
            out[t * 9 + k * 3] = gx + (rtc[0] as number);
            out[t * 9 + k * 3 + 1] = -gz + (rtc[1] as number);
            out[t * 9 + k * 3 + 2] = gy + (rtc[2] as number);
          }
          const v0 = indices ? (indices[t * 3] as number) : t * 3;
          idOut[t] = batchIds ? Math.round(batchIds[v0] as number) : 0;
        }
        tris.push(out);
        ids.push(idOut);
      }
    }
    for (const c of node.children ?? []) await visit(c, m);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots: number[] = scene ? scene.nodes : gltf.nodes.map((_: unknown, i: number) => i);
  for (const r of roots) await visit(r, IDENTITY);
  return {
    triangles: Float64Array.from(tris.flat()),
    batchIds: Uint32Array.from(ids.flat()),
    batch,
    batchLength,
    extensions,
  };
}

export async function fetchTile(url: string): Promise<DecodedTile> {
  const buf = await fetchCached(url);
  if (!buf) throw new Error(`${url} が見つかりません`);
  try {
    const magic = String.fromCharCode(...buf.subarray(0, 4));
    if (magic === 'glTF') return await decodeGlb(buf, null, 0);
    return await decodeB3dm(buf);
  } catch (err) {
    throw new Error(`${url} の復号に失敗しました: ${String(err)}`, { cause: err });
  }
}
