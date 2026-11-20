/**
 * PLATEAU の街並みが使うメモリの上限（建物の LRU キャッシュ・地面のタイル数・標高タイル数・テクスチャの大きさ）。
 * 端末のメモリと画面の幅から、スマートフォン向けの小さい値か、パソコン向けの値を選ぶ。
 */
import type { BufferAttribute } from 'three';

export interface BuildingCacheBudget {
  /** キャッシュの大きさ(byte)がこれを超えたら、使っていないタイルを解放する。 */
  minBytes: number;
  /** キャッシュの大きさ(byte)の上限。達すると新しいタイルを読まない。 */
  maxBytes: number;
  /** タイル数がこれを超えたら、使っていないタイルを解放する。 */
  minTiles: number;
  /** タイル数の上限。 */
  maxTiles: number;
}

export interface PlateauMemoryBudget {
  /** 建物の層（PlateauBuildings 1 つ）ごとの LRU キャッシュ。 */
  buildingCache: BuildingCacheBudget;
  /** 建物のテクスチャの長辺の上限(px)。 */
  maxTextureSize: number;
  /** 地面に保持するタイル数の上限。 */
  groundMaxTiles: number;
  /** 標高タイルのキャッシュの上限（タイル数。1 枚 256KB）。 */
  elevationMaxTiles: number;
}

export interface DeviceInfo {
  /** `navigator.deviceMemory`（GB。Chrome 系のみ。最大 8 に丸められる）。 */
  deviceMemoryGB?: number;
  /** 画面の短辺(CSS px)。 */
  screenShortSide?: number;
}

const MB = 1024 * 1024;

/** スマートフォン向け（メモリ 3〜4GB を想定）。 */
export const SMALL_DEVICE_BUDGET: PlateauMemoryBudget = {
  buildingCache: { minBytes: 64 * MB, maxBytes: 96 * MB, minTiles: 300, maxTiles: 400 },
  maxTextureSize: 512,
  groundMaxTiles: 120,
  elevationMaxTiles: 48,
};

/** パソコン向け。 */
export const DEFAULT_BUDGET: PlateauMemoryBudget = {
  buildingCache: { minBytes: 128 * MB, maxBytes: 192 * MB, minTiles: 600, maxTiles: 800 },
  maxTextureSize: 1024,
  groundMaxTiles: 240,
  elevationMaxTiles: 96,
};

/** いまの端末の情報（ブラウザの外では空）。 */
export function currentDeviceInfo(): DeviceInfo {
  if (typeof navigator === 'undefined' || typeof screen === 'undefined') return {};
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return { deviceMemoryGB: memory, screenShortSide: Math.min(screen.width, screen.height) };
}

/** メモリが 4GB 以下、または画面の短辺が 600px 以下ならスマートフォン向けとみなす。 */
export function isSmallDevice(info: DeviceInfo = currentDeviceInfo()): boolean {
  if (info.deviceMemoryGB !== undefined && info.deviceMemoryGB <= 4) return true;
  return info.screenShortSide !== undefined && info.screenShortSide <= 600;
}

/** 端末に合わせたメモリの上限。 */
export function plateauMemoryBudget(info: DeviceInfo = currentDeviceInfo()): PlateauMemoryBudget {
  return isSmallDevice(info) ? SMALL_DEVICE_BUDGET : DEFAULT_BUDGET;
}

/**
 * GPU へ転送した後に、CPU 側の配列を解放する（レイキャストなど CPU で読まない属性に使う）。
 * 配列は同じ型の空配列に差し替える（count は保つので描画には影響しない。CPU で読むと値は NaN になる）。
 */
export function releaseAfterUpload(attribute: BufferAttribute | undefined): void {
  if (!attribute || !attribute.isBufferAttribute) return;
  attribute.onUpload(function (this: BufferAttribute) {
    const ctor = this.array.constructor as new (length: number) => typeof this.array;
    this.array = new ctor(0);
  });
}
