/**
 * 本文に埋め込む数値の書き方（新聞の表記に合わせる）。
 * - 1万以上は「万」を使う: 13394 → "1万3,394"、120509 → "12万509"、5798477 → "579万8,477"。
 * - 1万未満は3桁区切り: 6358 → "6,358"。
 */
const grouping = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

export function formatJaCount(value: number): string {
  const n = Math.round(value);
  if (Math.abs(n) < 10_000) return grouping.format(n);
  const man = Math.trunc(n / 10_000);
  const rest = Math.abs(n % 10_000);
  return `${grouping.format(man)}万${rest > 0 ? grouping.format(rest) : ''}`;
}

/** 小数を桁数どおりに書く: (64.4, 1) → "64.4"、(2.5, 1) → "2.5"。 */
export function formatDecimal(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits);
}
