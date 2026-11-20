import { clamp01 } from './cameraPath';

/** 段階内の進捗がこの値に達した時点で数え上がりを終える。カメラが止まっている区間（DEFAULT_HOLD）の中に収める。 */
export const COUNT_END = 0.25;

const formatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

/** 桁区切りつきの文字列にする（例: 1234567 → "1,234,567"）。 */
export function formatCount(value: number): string {
  return formatter.format(Math.round(value));
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * 段階内の進捗 progress(0〜1) のときに表示する数値。0 から target まで数え上がる。
 * progress が countEnd 以上なら target ちょうど。instant が true なら常に target。
 */
export function countValue(
  target: number,
  progress: number,
  options: { countEnd?: number; instant?: boolean } = {},
): number {
  if (options.instant) return target;
  const end = options.countEnd ?? COUNT_END;
  const t = end <= 0 ? 1 : clamp01(progress / end);
  return t >= 1 ? target : Math.round(target * easeOutCubic(t));
}
