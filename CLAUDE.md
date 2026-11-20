# photo-thematic-map

統計の実数ぶんの3Dオブジェクトを東京の街（Project PLATEAU の 3D Tiles）に積み上げ、ランドマークと並べて量を体感させる Web 3D 作品。静的サイト（GitHub Pages）として公開する。

## スタック

Vite + TypeScript(strict) / three@0.187.0 / 3d-tiles-renderer@0.5.4 / vitest / eslint(typescript-eslint) / @playwright/test@1.63.0。`vite.config.ts` の `base` は `'./'`（サブパス配信のため変更しない）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run build` | 型チェック＋本番ビルド（`dist/`） |
| `npm run preview` | `dist/` の配信 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm test` | vitest（`tests/unit/`） |
| `npm run test:e2e` | ビルド → preview 起動 → Playwright（`tests/e2e/`）。スクリーンショットは `screenshots/`（Playwright の `outputDir` である `test-results/` は実行開始時に消去されるため別にしている） |

E2E は `/opt/pw-browsers/chromium` を使う。preview サーバーのポートは環境変数 `E2E_PORT`（既定 4173）で変えられ、既存のサーバーは再利用しない。別の場所の Chrome を使うときは環境変数 `CHROMIUM_PATH` で指定する。ヘッドレス WebGL は SwiftShader のソフトウェア描画（起動オプションは `playwright.config.ts`）。

## ディレクトリ構成

- `src/scene/` 描画（renderer・シーン・カメラ・PLATEAU 表示）
- `src/geo/` 座標変換（`enu.ts`）
- `src/sim/` 堆積計算（描画に依存しない純粋ロジック）
- `src/story/` スクロール連動
- `src/config.ts` 共有定数（座標原点など）
- `scripts/` データ取得スクリプト（Node 実行。成果物は `public/` 等へ出力）
- `tests/unit/` vitest、`tests/e2e/` Playwright
- `public/` 静的アセット

## 機能ごとの確認ページ（demos）

機能は本編（`index.html`・`src/main.ts`）に組み込む前に、単独で動く確認ページとして作る。本編への統合はオーケストレータが行う。

- ページ: `demos/<機能名>.html`（`<script type="module" src="/src/demos/<機能名>.ts">` を読み込む）
- エントリ: `src/demos/<機能名>.ts`
- E2E: `tests/e2e/<機能名>.spec.ts`（`/demos/<機能名>.html` を開き、`__APP_READY__` とコンソールエラー0件を確認し、`screenshots/<機能名>.png` を保存する）
- `vite.config.ts` が `demos/*.html` を自動でビルド対象に含めるので、設定の変更は不要。
- 機能の本体は `src/scene/` `src/sim/` `src/story/` に再利用できるモジュールとして置き、確認ページからはそれを呼ぶだけにする。

## 静的アセットのパスと favicon

- `public/` のファイルは `fetch('./data/...')` や `import.meta.env.BASE_URL` ではなく、必ず `src/paths.ts` の `assetUrl('data/sample.json')` 経由で読む。`base: './'` のため、ページ URL の深さ（本編 `/` と確認ページ `/demos/x.html`）で相対パスの指す先が変わる。`assetUrl` はモジュールの位置を基準にするので、開発時・本番・サブパス配信（`/photo-thematic-map/`）のどれでも公開ルートを指す。
- 確認ページ（`demos/*.html`）の favicon などの `public/` への参照は、ルート絶対パス（`/favicon.svg`）で書く。Vite がビルド時に各 HTML からの相対パスへ書き換える。
- `vite.config.ts` は `appType: 'mpa'` なので、存在しないパスには 404 が返る（`vite preview` でも index.html にならない）。

## 座標規約

- three.js ワールド座標: **X=東、Y=上、Z=南（−Z が北）、1単位=1m**。
- 原点は `src/config.ts` の `ORIGIN`（既定: 東京駅 緯度 35.68124 / 経度 139.76712 / 標高 0）。ローカル Y=0 が標高 `ORIGIN.alt`。
- 緯度経度（度）とローカル座標の変換は必ず `src/geo/enu.ts` の `latLonToLocal` / `localToLatLon` を使う。別実装を作らない。
- ENU との対応: `x = east`, `y = up`, `z = -north`。
- 変換は WGS84 の ECEF を経由する厳密な ENU（原点で楕円体に接する平面）。ECEF 座標のデータ（3D Tiles）は `ecefToLocalMatrix()` の行列で同じ座標系に載せる。返り値は行優先なので `new Matrix4().set(...m)` で使う（列優先の `fromArray` は使えない）。
- 接平面なので、原点から離れると地表は Y の負の方向へ下がる（10km で約 8m、20km で約 31m）。離れた地点に物を置くときは、その地点の地表の Y を基準にする。

## 規約

- コミット前に `npm run typecheck`・`npm run lint`・`npm test`・`npm run test:e2e` をすべて通す。
- アプリは最初のフレーム描画後に `window.__APP_READY__ = true` を設定する。E2E はこれを待つ。
- コンソールエラー0件を保つ（E2E が検査する）。
- 作業ブランチは `claude/*`。PR のタイトル・本文は日本語。
