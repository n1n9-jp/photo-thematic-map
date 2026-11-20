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
| `npm run test:e2e` | ビルド → preview 起動 → Playwright（`tests/e2e/`）。スクリーンショットは `test-results/` |

E2E は `/opt/pw-browsers/chromium` を使う。別の場所の Chrome を使うときは環境変数 `CHROMIUM_PATH` で指定する。ヘッドレス WebGL は SwiftShader のソフトウェア描画（起動オプションは `playwright.config.ts`）。

## ディレクトリ構成

- `src/scene/` 描画（renderer・シーン・カメラ・PLATEAU 表示）
- `src/geo/` 座標変換（`enu.ts`）
- `src/sim/` 堆積計算（描画に依存しない純粋ロジック）
- `src/story/` スクロール連動
- `src/config.ts` 共有定数（座標原点など）
- `scripts/` データ取得スクリプト（Node 実行。成果物は `public/` 等へ出力）
- `tests/unit/` vitest、`tests/e2e/` Playwright
- `public/` 静的アセット

## 座標規約

- three.js ワールド座標: **X=東、Y=上、Z=南（−Z が北）、1単位=1m**。
- 原点は `src/config.ts` の `ORIGIN`（既定: 東京駅 緯度 35.68124 / 経度 139.76712 / 標高 0）。ローカル Y=0 が標高 `ORIGIN.alt`。
- 緯度経度（度）とローカル座標の変換は必ず `src/geo/enu.ts` の `latLonToLocal` / `localToLatLon` を使う。別実装を作らない。
- ENU との対応: `x = east`, `y = up`, `z = -north`。
- 原点から数十 km 以内の局所近似（WGS84 曲率半径）。

## 規約

- コミット前に `npm run typecheck`・`npm run lint`・`npm test`・`npm run test:e2e` をすべて通す。
- アプリは最初のフレーム描画後に `window.__APP_READY__ = true` を設定する。E2E はこれを待つ。
- コンソールエラー0件を保つ（E2E が検査する）。
- 作業ブランチは `claude/*`。PR のタイトル・本文は日本語。
