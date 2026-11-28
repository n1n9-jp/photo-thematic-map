/**
 * 表紙（index.html の冒頭）に埋め込む数値。数値の訂正は facts.ts の1か所で済むようにする。
 *
 * 表紙の文は、JavaScript を待たずに最初の描画で読めるよう index.html に直接書き、数値だけを
 * `{{ptm:キー}}` の形で書いておく。ビルド時（開発サーバーでも）に vite.config.ts のプラグインが
 * `fillCoverTokens` でこの値に置き換える。
 * vite.config.ts が Vite の設定の読み込み（Node）からも読むので、import には拡張子 .ts を付ける。
 */
import { FACTS, FISCAL_YEAR, REPORT_YEARS, SURVEY } from './facts.ts';
import { formatJaCount } from './format.ts';

export const COVER_VALUES = {
  surveyYear: String(SURVEY.year),
  surveyMonth: String(SURVEY.month),
  /** 例: 1万3,394台 */
  totalParked: `${formatJaCount(FACTS.totalParked.value)}${FACTS.totalParked.unit}`,
  fiscalYear: String(FISCAL_YEAR),
  /** 例: 18万7,262台 */
  removedFY2024: `${formatJaCount(FACTS.removedFY2024.value)}${FACTS.removedFY2024.unit}`,
  /** 例: 令和7年度 */
  reportYear: `令和${REPORT_YEARS.lastReiwa}年度`,
} as const satisfies Record<string, string>;

export type CoverKey = keyof typeof COVER_VALUES;

const TOKEN = /\{\{ptm:([A-Za-z0-9]+)\}\}/g;

/** HTML の `{{ptm:キー}}` を COVER_VALUES の値に置き換える。知らないキーがあれば例外（ビルドを止める）。 */
export function fillCoverTokens(html: string): string {
  return html.replace(TOKEN, (_, key: string) => {
    if (!Object.hasOwn(COVER_VALUES, key)) throw new Error(`表紙の数値のキーが facts にありません: {{ptm:${key}}}`);
    return COVER_VALUES[key as CoverKey];
  });
}
