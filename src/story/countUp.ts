import { clamp01 } from './cameraPath';

/** 数値の要素が画面に入ってから、最終値まで数え上がるのにかける時間(ms)。 */
export const COUNT_DURATION_MS = 1200;

const formatters = new Map<number, Intl.NumberFormat>();

function roundTo(value: number, fractionDigits: number): number {
  const k = 10 ** fractionDigits;
  return Math.round(value * k) / k;
}

/** 桁区切りつきの文字列にする（例: 1234567 → "1,234,567"）。fractionDigits は小数点以下の桁数（既定 0）。 */
export function formatCount(value: number, fractionDigits = 0): string {
  let f = formatters.get(fractionDigits);
  if (!f) {
    f = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
    formatters.set(fractionDigits, f);
  }
  return f.format(roundTo(value, fractionDigits));
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * 数え上げの経過 fraction(0〜1。経過時間 ÷ `COUNT_DURATION_MS`) のときに表示する数値。0 から target まで数え上がる。
 * fraction が 1 以上なら target ちょうど。instant が true なら常に target。
 */
export function countValue(
  target: number,
  fraction: number,
  options: { instant?: boolean; fractionDigits?: number } = {},
): number {
  if (options.instant) return target;
  const t = clamp01(fraction);
  return t >= 1 ? target : roundTo(target * easeOutCubic(t), options.fractionDigits ?? 0);
}
