/**
 * 公開ルート（`public/` の中身が置かれる場所）からの相対パスを、絶対 URL にする。
 *
 * `base: './'`（GitHub Pages のサブパス配信のため）では、ページの URL の深さによって
 * `./data/x.json` の指す先が変わる（本編 `/` と確認ページ `/demos/x.html` で別の場所になる）。
 * そこで、ページではなくこのモジュール自身の位置を基準にする。
 *
 * - 開発時: このファイルは `/src/paths.ts` で、`..` は `/`。
 * - 本番: 取り込み先のチャンクは `assets/*.js` に出力され、`..` は公開ルート。
 *   サブパス配信（`/photo-thematic-map/assets/*.js`）でも `/photo-thematic-map/` になる。
 *
 * `new URL('..', import.meta.url)` と直接書くと Vite が静的アセット参照として変換してしまうため、
 * 相対パスを一度変数に入れてから渡している。
 */
const PARENT = '..';
const PUBLIC_ROOT = new URL(PARENT, import.meta.url);

/** `public/` 内のファイル（例: `data/sample.json`）の絶対 URL を返す。先頭の `/` や `./` は無視する。 */
export function assetUrl(path: string): string {
  return new URL(path.replace(/^(\.?\/)+/, ''), PUBLIC_ROOT).href;
}
