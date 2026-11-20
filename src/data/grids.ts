/**
 * 街の高さ格子（`public/data/grids/<名前>.*`）の形式と読み込み。
 *
 * ファイル（`npm run data:grids` = `scripts/bake/` が生成する）:
 * - `<名前>.json` メタ情報（{@link GridMeta}）。
 * - `<名前>.height.bin` 地表の高さ（建物・橋梁のあるセルは屋上、ないセルは地面）。Uint16 リトルエンディアン。
 * - `<名前>.ground.bin` 建物・橋梁を除いた地面の高さ。Uint16 リトルエンディアン。
 * - `<名前>.class.bin` 分類（{@link GRID_CLASS}）。Uint8。0=地面、1=建物、2=橋梁・高架、255=標高データなし（主に水面）。
 *
 * 並びは {@link HeightGrid} と同じ（行優先、行 0 が北端、列は東向き）。
 * 高さは `value = offset + q * scale`（m, ローカル Y）。`q = nodata`（65535）は欠損（NaN）。
 *
 * ブラウザ（`loadCityGrid`、URL から）と Node（`cityGridFromBytes`、バイト列から）の両方で使える。
 */
import { assetUrl } from '../paths';
import type { HeightGrid } from '../sim/heightGrid';

/** 出力済みの地区。 */
export const GRID_NAMES = ['akihabara', 'marunouchi', 'shinjuku'] as const;
export type GridName = (typeof GRID_NAMES)[number];

/** 堆積計算の試し（確認ページの `?pile=1` と `npm run data:grids:pile`）。安息角 35°。 */
export const GRID_PILE_TRIALS: Partial<Record<GridName, { label: string; lat: number; lon: number; volume: number }>> = {
  marunouchi: { label: '東京駅丸の内駅前広場', lat: 35.6814, lon: 139.766, volume: 66_000 },
  shinjuku: { label: '新宿中央公園', lat: 35.69, lon: 139.6895, volume: 2_030_000 },
};
export const GRID_PILE_ANGLE = 35;

/** 分類の値。 */
export const GRID_CLASS = {
  ground: 0,
  building: 1,
  bridge: 2,
  /** 標高データなし（主に水面: お濠・川）。高さは近傍の最も低い地面の値で埋めてある。 */
  nodata: 255,
} as const;

/** 量子化した高さの欠損値。 */
export const QUANT_NODATA = 65535;

/** Uint16 への量子化の係数。value = offset + q * scale。 */
export interface Quantization {
  offset: number;
  scale: number;
  nodata: number;
}

export interface GridFileInfo {
  /** `public/` からの相対パス。 */
  path: string;
  bytes: number;
  sha256: string;
}

export interface GridMeta {
  formatVersion: 1;
  name: string;
  /** 列数（東西）。 */
  width: number;
  /** 行数（南北）。 */
  height: number;
  /** セルの一辺(m)。 */
  cellSize: number;
  /** 格子の北西の角のローカル X(m)。 */
  originX: number;
  /** 格子の北西の角のローカル Z(m)。 */
  originZ: number;
  /** 地区の中心（指定値）。 */
  center: { lat: number; lon: number };
  /** 高さの基準の説明。 */
  heightReference: {
    /** ローカル Y = 標高(m)。水平は latLonToLocal（CLAUDE.md の座標規約）。 */
    description: string;
    origin: { lat: number; lon: number; alt: number };
    /** 3D Tiles の頂点の高さが楕円体高であること。 */
    tilesHeight: 'ellipsoidal';
    /** 3D Tiles の楕円体高から引いたジオイド高（src/config.ts の GEOID_HEIGHT_M）。 */
    geoidHeightM: number;
  };
  quantization: { height: Quantization; ground: Quantization };
  classes: Record<string, number>;
  files: { height: GridFileInfo; ground: GridFileInfo; class: GridFileInfo };
  sources: unknown;
  generatedAt: string;
  stats: unknown;
  landmarks?: unknown;
}

/** 読み込んだ格子。 */
export interface CityGrid {
  meta: GridMeta;
  /** 地表（屋上を含む）の高さ。 */
  surface: HeightGrid;
  /** 建物・橋梁を除いた地面の高さ。 */
  ground: HeightGrid;
  /** 分類（{@link GRID_CLASS}）。 */
  classes: Uint8Array;
}

/**
 * 高さ（m）を Uint16 に量子化する。NaN は nodata。
 * offset は最小値を scale の倍数に切り下げた値（同じ入力から同じ結果になる）。
 * 範囲が scale × 65534 を超えると例外。
 */
export function quantizeHeights(values: Float32Array, scale: number): { data: Uint16Array; q: Quantization } {
  if (!(scale > 0)) throw new RangeError('scale は正の数で指定してください');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const offset = Number.isFinite(min) ? Math.floor(min / scale) * scale : 0;
  // 浮動小数の誤差で offset の表記が揺れないよう丸める。
  const off = Number(offset.toFixed(6));
  if (Number.isFinite(max) && Math.round((max - off) / scale) > QUANT_NODATA - 1) {
    throw new RangeError(`高さの範囲が広すぎます（${min}〜${max} m, 刻み ${scale} m）`);
  }
  const data = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    data[i] = Number.isNaN(v) ? QUANT_NODATA : Math.max(0, Math.round((v - off) / scale));
  }
  return { data, q: { offset: off, scale, nodata: QUANT_NODATA } };
}

/** 量子化した高さを m に戻す。 */
export function dequantizeHeights(data: Uint16Array, q: Quantization): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    out[i] = v === q.nodata ? Number.NaN : q.offset + v * q.scale;
  }
  return out;
}

/** Uint16 の配列をリトルエンディアンのバイト列にする。 */
export function uint16ToBytes(data: Uint16Array): Uint8Array {
  const out = new Uint8Array(data.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < data.length; i++) view.setUint16(i * 2, data[i] as number, true);
  return out;
}

/** リトルエンディアンのバイト列を Uint16 の配列にする。 */
export function bytesToUint16(bytes: Uint8Array): Uint16Array {
  if (bytes.byteLength % 2 !== 0) throw new RangeError('Uint16 のバイト列の長さが奇数です');
  const out = new Uint16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

export interface GridBytes {
  height: Uint8Array;
  ground: Uint8Array;
  classes: Uint8Array;
}

/** メタ情報とバイト列から格子を復元する。大きさが合わなければ例外。 */
export function cityGridFromBytes(meta: GridMeta, bytes: GridBytes): CityGrid {
  const n = meta.width * meta.height;
  if (!(Number.isInteger(n) && n > 0)) throw new RangeError('格子の大きさが不正です');
  if (bytes.height.byteLength !== n * 2) throw new RangeError(`height.bin の大きさが合いません（${bytes.height.byteLength} ≠ ${n * 2}）`);
  if (bytes.ground.byteLength !== n * 2) throw new RangeError(`ground.bin の大きさが合いません（${bytes.ground.byteLength} ≠ ${n * 2}）`);
  if (bytes.classes.byteLength !== n) throw new RangeError(`class.bin の大きさが合いません（${bytes.classes.byteLength} ≠ ${n}）`);
  const base = {
    width: meta.width,
    height: meta.height,
    cellSize: meta.cellSize,
    originX: meta.originX,
    originZ: meta.originZ,
  };
  return {
    meta,
    surface: { ...base, data: dequantizeHeights(bytesToUint16(bytes.height), meta.quantization.height) },
    ground: { ...base, data: dequantizeHeights(bytesToUint16(bytes.ground), meta.quantization.ground) },
    classes: Uint8Array.from(bytes.classes),
  };
}

/** メタ情報の URL（`public/` 基準）。 */
export function gridMetaPath(name: string): string {
  return `data/grids/${name}.json`;
}

async function fetchBytes(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗しました（HTTP ${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}

/** `public/data/grids/` から格子を読み込む（ブラウザ用）。 */
export async function loadCityGrid(name: string, fetchImpl: typeof fetch = fetch): Promise<CityGrid> {
  const metaRes = await fetchImpl(assetUrl(gridMetaPath(name)));
  if (!metaRes.ok) throw new Error(`格子 ${name} のメタ情報の取得に失敗しました（HTTP ${metaRes.status}）`);
  const meta = (await metaRes.json()) as GridMeta;
  const [height, ground, classes] = await Promise.all([
    fetchBytes(assetUrl(meta.files.height.path), fetchImpl),
    fetchBytes(assetUrl(meta.files.ground.path), fetchImpl),
    fetchBytes(assetUrl(meta.files.class.path), fetchImpl),
  ]);
  return cityGridFromBytes(meta, { height, ground, classes });
}
