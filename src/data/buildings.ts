/**
 * 変換済みの建物（`public/data/buildings/`。`npm run data:buildings` = `scripts/bake/buildings.ts` が生成する）の形式。
 *
 * ファイル:
 * - `manifest.json` メタ情報（{@link BuildingManifest}）。使ったタイルセット・範囲・チャンクの一覧（大きさとハッシュ）。
 * - `<level>/<ix>_<iz>.bin` チャンク 1 つの形。gzip で圧縮した {@link encodeBuildingChunk} のバイト列。
 *
 * チャンクは平らな地図（CLAUDE.md の座標規約。X=東, Y=標高, Z=南）を一辺 `chunkSizeM` の正方形に区切ったもの。
 * チャンク (ix, iz) は x ∈ [ix·s, (ix+1)·s)、z ∈ [iz·s, (iz+1)·s)。建物は足元の中心でチャンクに割り当てるので、
 * 形はチャンクの外へはみ出すことがある（境界で建物を切らない）。
 *
 * チャンクのバイト列（gzip の前。リトルエンディアン）:
 * ```
 *  0  'PTMB'
 *  4  u16 版（1）  u16 フラグ（bit0: 索引が 32bit）
 *  8  u32 頂点数 V  12 u32 三角形数 T
 * 16  f32×3 原点 (x, y, z)   28 f32×3 刻み (x, y, z)    位置 = 原点 + q × 刻み
 * 40  u32 索引のバイト数 L
 * 44  u32 群の数 G      48  u32×(G+1) 群ごとの最初の三角形の番号（最後は T）
 * H = 52+4G  頂点: 成分（x, y, z）ごとに、前の頂点との差（16bit で折り返す）をジグザグにした値の下位バイト V 個、上位バイト V 個
 * H+6V  索引: 3T 個。頂点は初めて使われる順に並べてあり、各索引を「まだ使っていない最小の番号 − 索引」の LEB128 で書く
 * ```
 * 群は、チャンクを細かい区画（セル）に分けたときの区画ごとの三角形の範囲。遠景（far）のチャンクは
 * 詳細（detail）のセル 4×4 個ぶんを 1 ファイルにし、詳細を表示しているセルの範囲だけを描かないために使う。
 * 差分とバイトの分離は gzip で縮みやすくするため。復号は配列を 1 回なめるだけで済む。
 * 法線は持たない（白い建物は面ごとの陰影 `flatShading` で描く）。属性情報とテクスチャも持たない。
 */
import { assetUrl } from '../paths';

export const BUILDING_FORMAT_VERSION = 1;
const MAGIC = 0x424d5450; // 'PTMB'
const FIXED_HEADER_BYTES = 48;

/** 詳細度。detail = LOD2 の形そのまま（建物・橋梁）、far = LOD1 の箱（遠景。ある高さ以上の建物だけ）。 */
export type BuildingLevel = 'detail' | 'far';

export interface BuildingChunkMesh {
  /** 量子化した位置（x, y, z の順に 3 個ずつ）。 */
  positions: Uint16Array;
  /** 三角形の索引。 */
  indices: Uint16Array | Uint32Array;
  origin: [number, number, number];
  step: [number, number, number];
  /** 群ごとの最初の三角形の番号（長さ G+1。最後は三角形の数）。 */
  groups: Uint32Array;
}

/**
 * 三角形（群ごとの配列。9 要素で 1 三角形、ローカル座標 m）を量子化して 1 つのメッシュにする。
 * 刻みは各軸 `minStep` 以上で、範囲が 16bit に収まる大きさ。
 * 量子化で同じ位置になった頂点は 1 つにまとめ、面積のなくなった三角形は捨てる。
 */
export function quantizeTriangles(groupTris: readonly (Float32Array | Float64Array)[], minStep: number): BuildingChunkMesh {
  let n = 0;
  for (const g of groupTris) n += g.length / 3;
  const tris = new Float64Array(n * 3);
  {
    let o = 0;
    for (const g of groupTris) {
      tris.set(g, o);
      o += g.length;
    }
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i * 3 + k] as number;
      if (v < (lo[k] as number)) lo[k] = v;
      if (v > (hi[k] as number)) hi[k] = v;
    }
  }
  const groups = new Uint32Array(groupTris.length + 1);
  if (n === 0) return { positions: new Uint16Array(0), indices: new Uint16Array(0), origin: [0, 0, 0], step: [1, 1, 1], groups };
  // 原点は刻みの倍数に丸める（同じ入力なら同じ値。f32 で表せる値にする）
  const step = [0, 1, 2].map((k) => Math.fround(Math.max(minStep, ((hi[k] as number) - (lo[k] as number)) / 65000))) as [number, number, number];
  const origin = [0, 1, 2].map((k) => Math.fround(Math.floor((lo[k] as number) / (step[k] as number)) * (step[k] as number))) as [number, number, number];
  const q = new Uint16Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = Math.round(((tris[i * 3 + k] as number) - (origin[k] as number)) / (step[k] as number));
      q[i * 3 + k] = Math.min(65535, Math.max(0, v));
    }
  }
  // 同じ位置の頂点をまとめ、初めて使われる順に番号を振る
  const ids = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const keys = [0, 0, 0];
  const groupEnd: number[] = [];
  {
    let e = 0;
    for (const g of groupTris) groupEnd.push((e += g.length / 9));
  }
  let gi = 0;
  for (let t = 0; t < n / 3; t++) {
    while (gi < groupEnd.length && t >= (groupEnd[gi] as number)) groups[++gi] = indices.length / 3;
    for (let k = 0; k < 3; k++) {
      const b = (t * 3 + k) * 3;
      keys[k] = ((q[b] as number) * 65536 + (q[b + 1] as number)) * 65536 + (q[b + 2] as number);
    }
    if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) continue;
    for (let k = 0; k < 3; k++) {
      const key = keys[k] as number;
      let id = ids.get(key);
      if (id === undefined) {
        const b = (t * 3 + k) * 3;
        id = positions.length / 3;
        positions.push(q[b] as number, q[b + 1] as number, q[b + 2] as number);
        ids.set(key, id);
      }
      indices.push(id);
    }
  }
  while (gi < groupTris.length) groups[++gi] = indices.length / 3;
  const V = positions.length / 3;
  return {
    positions: Uint16Array.from(positions),
    indices: V > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices),
    origin,
    step,
    groups,
  };
}

/** メッシュをバイト列にする（gzip の前）。頂点は初めて使われる順に並んでいること（{@link quantizeTriangles} の出力）。 */
export function encodeBuildingChunk(mesh: BuildingChunkMesh): Uint8Array {
  const V = mesh.positions.length / 3;
  const T = mesh.indices.length / 3;
  // 索引
  const idx: number[] = [];
  let next = 0;
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i] as number;
    if (v > next) throw new Error('頂点が初めて使われる順に並んでいません');
    let code = next - v;
    if (v === next) next++;
    while (code >= 0x80) {
      idx.push((code & 0x7f) | 0x80);
      code >>>= 7;
    }
    idx.push(code);
  }
  const G = mesh.groups.length - 1;
  const H = FIXED_HEADER_BYTES + 4 * (G + 1);
  const out = new Uint8Array(H + 6 * V + idx.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint16(4, BUILDING_FORMAT_VERSION, true);
  dv.setUint16(6, mesh.indices instanceof Uint32Array ? 1 : 0, true);
  dv.setUint32(8, V, true);
  dv.setUint32(12, T, true);
  for (let k = 0; k < 3; k++) {
    dv.setFloat32(16 + k * 4, mesh.origin[k] as number, true);
    dv.setFloat32(28 + k * 4, mesh.step[k] as number, true);
  }
  dv.setUint32(40, idx.length, true);
  dv.setUint32(44, G, true);
  for (let g = 0; g <= G; g++) dv.setUint32(FIXED_HEADER_BYTES + 4 * g, mesh.groups[g] as number, true);
  for (let k = 0; k < 3; k++) {
    const loOff = H + k * 2 * V;
    const hiOff = loOff + V;
    let prev = 0;
    for (let i = 0; i < V; i++) {
      const cur = mesh.positions[i * 3 + k] as number;
      const d = (cur - prev) << 16 >> 16; // −32768〜32767 に折り返す
      const z = ((d << 1) ^ (d >> 31)) & 0xffff;
      out[loOff + i] = z & 0xff;
      out[hiOff + i] = z >>> 8;
      prev = cur;
    }
  }
  out.set(idx, H + 6 * V);
  return out;
}

/** {@link encodeBuildingChunk} のバイト列（gzip を解いたもの）を復号する。 */
export function decodeBuildingChunk(bytes: Uint8Array): BuildingChunkMesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < FIXED_HEADER_BYTES || dv.getUint32(0, true) !== MAGIC) throw new Error('建物のチャンクではありません');
  const version = dv.getUint16(4, true);
  if (version !== BUILDING_FORMAT_VERSION) throw new Error(`未対応の建物のチャンクの版です: ${version}`);
  const wide = (dv.getUint16(6, true) & 1) === 1;
  const V = dv.getUint32(8, true);
  const T = dv.getUint32(12, true);
  const origin: [number, number, number] = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
  const step: [number, number, number] = [dv.getFloat32(28, true), dv.getFloat32(32, true), dv.getFloat32(36, true)];
  const L = dv.getUint32(40, true);
  const G = dv.getUint32(44, true);
  const H = FIXED_HEADER_BYTES + 4 * (G + 1);
  if (bytes.byteLength < H + 6 * V + L) throw new Error('建物のチャンクが途中で切れています');
  const groups = new Uint32Array(G + 1);
  for (let g = 0; g <= G; g++) groups[g] = dv.getUint32(FIXED_HEADER_BYTES + 4 * g, true);
  const positions = new Uint16Array(V * 3);
  for (let k = 0; k < 3; k++) {
    const loOff = H + k * 2 * V;
    const hiOff = loOff + V;
    let prev = 0;
    for (let i = 0; i < V; i++) {
      const z = (bytes[loOff + i] as number) | ((bytes[hiOff + i] as number) << 8);
      prev = (prev + ((z >>> 1) ^ -(z & 1))) & 0xffff;
      positions[i * 3 + k] = prev;
    }
  }
  const indices = wide ? new Uint32Array(T * 3) : new Uint16Array(T * 3);
  let p = H + 6 * V;
  const end = p + L;
  let next = 0;
  for (let i = 0; i < T * 3; i++) {
    let code = 0;
    let shift = 0;
    for (;;) {
      if (p >= end) throw new Error('建物のチャンクの索引が途中で切れています');
      const b = bytes[p++] as number;
      code |= (b & 0x7f) << shift;
      if (b < 0x80) break;
      shift += 7;
    }
    const v = next - code;
    if (code === 0) next++;
    if (v < 0 || v >= V) throw new Error('建物のチャンクの索引が範囲の外です');
    indices[i] = v;
  }
  return { positions, indices, origin, step, groups };
}

/** gzip で圧縮されているか（先頭の 2 バイト）。配信側で展開済みのこともあるので確かめてから解く。 */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// ---------------------------------------------------------------------------
// メタ情報
// ---------------------------------------------------------------------------

export interface BuildingChunkInfo {
  level: BuildingLevel;
  ix: number;
  iz: number;
  /** 公開ルートからのパス。 */
  path: string;
  /** ファイルの大きさ（gzip 後, byte）。 */
  bytes: number;
  /** gzip 前の大きさ(byte)。 */
  rawBytes: number;
  sha256: string;
  triangles: number;
  vertices: number;
  /** 地物（建物・橋梁）の数。 */
  features: number;
  /** 形の高さの範囲（ローカル Y, m）。 */
  minY: number;
  maxY: number;
}

export interface BuildingLevelInfo {
  /** チャンクの一辺(m)。far は detail の整数倍（far のチャンク 1 つが detail のセル `cellsPerSide`² 個）。 */
  chunkSizeM: number;
  /** チャンクの中の群（detail のセル）の一辺の数。detail は 1。 */
  cellsPerSide: number;
  description: string;
  /** 本編で、カメラからこの水平距離(m)以内のチャンクにこの詳細度を使う（目安。far は霧の範囲でも制限する）。 */
  viewDistanceM: number;
}

export interface BuildingPlaceInfo {
  name: string;
  label: string;
  /** 範囲を決めた点（場面の注視点とカメラの位置）。 */
  points: { scene: string; role: 'target' | 'camera'; lat: number; lon: number; x: number; z: number; heightM: number }[];
  /** 点からこの水平距離(m)に掛かるチャンクを、詳細度ごとに出力した。 */
  radiusM: Record<BuildingLevel, number>;
  chunks: Record<BuildingLevel, number>;
  /** 場所のチャンク（詳細度ごと）の大きさの合計（gzip 後, byte）。 */
  bytes: Record<BuildingLevel, number>;
}

export interface BuildingManifest {
  formatVersion: number;
  /** 入力（変換の方法・範囲・タイルセットの一覧）のハッシュ。同じなら作り直さない。 */
  inputHash: string;
  generatedAt: string;
  coordinates: string;
  levels: Record<BuildingLevel, BuildingLevelInfo>;
  places: BuildingPlaceInfo[];
  sources: {
    catalog: string;
    tilesets: { level: BuildingLevel; type: 'bldg' | 'brid'; city: string; lod: number; texture: boolean; year: number; url: string; leafTiles: number }[];
    method: string;
  };
  totals: { files: number; bytes: number; rawBytes: number; triangles: number; byLevel: Record<BuildingLevel, { files: number; bytes: number; rawBytes: number; triangles: number }> };
  chunks: BuildingChunkInfo[];
  /**
   * 詳細（detail）を出力したセル（"ix_iz"）。建物のないセルも含む（ファイルはない）。
   * ここにないセルは、遠景（far）だけで描く。
   */
  detailCells: string[];
}

export const BUILDING_MANIFEST_PATH = 'data/buildings/manifest.json';

/** チャンクのファイルのパス（公開ルートから）。 */
export function buildingChunkPath(level: BuildingLevel, ix: number, iz: number): string {
  return `data/buildings/${level}/${ix}_${iz}.bin`;
}

/** メタ情報を読む。読めなければ null。 */
export async function loadBuildingManifest(url = assetUrl(BUILDING_MANIFEST_PATH)): Promise<BuildingManifest | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const m = (await res.json()) as BuildingManifest;
    return m.formatVersion === BUILDING_FORMAT_VERSION ? m : null;
  } catch {
    return null;
  }
}
