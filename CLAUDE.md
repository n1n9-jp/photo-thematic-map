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
| `npm run data:plateau` | PLATEAU データカタログから23区の建物 3D Tiles の URL を `public/data/plateau/tilesets.json` に書き出す |

E2E は `/opt/pw-browsers/chromium` を使う。別の場所の Chrome を使うときは環境変数 `CHROMIUM_PATH` で指定する。ヘッドレス WebGL は SwiftShader のソフトウェア描画（起動オプションは `playwright.config.ts`）。

## ディレクトリ構成

- `src/scene/` 描画（renderer・シーン・カメラ・PLATEAU 表示）
  - `src/scene/plateau/` PLATEAU の街並み。`stage.ts`（舞台一式）、`buildings.ts`（建物 3D Tiles）、`ground.ts`（航空写真の地面）、`elevation.ts`（標高）、`catalog.ts`（tileset 一覧）、`attribution.ts`（出典表示）
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
- E2E: `tests/e2e/<機能名>.spec.ts`（`/demos/<機能名>.html` を開き、`__APP_READY__` とコンソールエラー0件を確認し、`test-results/<機能名>.png` を保存する）
- `vite.config.ts` が `demos/*.html` を自動でビルド対象に含めるので、設定の変更は不要。
- 機能の本体は `src/scene/` `src/sim/` `src/story/` に再利用できるモジュールとして置き、確認ページからはそれを呼ぶだけにする。

## 座標規約

- three.js ワールド座標: **X=東、Y=上、Z=南（−Z が北）、1単位=1m**。
- 原点は `src/config.ts` の `ORIGIN`（既定: 東京駅 緯度 35.68124 / 経度 139.76712 / 標高 0）。ローカル Y=0 が標高 `ORIGIN.alt`。
- 緯度経度（度）とローカル座標の変換は必ず `src/geo/enu.ts` の `latLonToLocal` / `localToLatLon` を使う。別実装を作らない。
- ENU との対応: `x = east`, `y = up`, `z = -north`。
- 原点から数十 km 以内の局所近似（WGS84 曲率半径）。地球の丸みは持たない（平面）。

### 高さの基準（PLATEAU）

- **ローカル Y は標高**（東京湾平均海面基準, m）。
- PLATEAU 建物 3D Tiles のジオメトリは ECEF・**楕円体高**。建物属性 `_zmin` / `_zmax` は**標高**。
  実測（`_zmin` とタイル高さ範囲の差）でジオイド高は東京駅周辺 36.66m、渋谷駅周辺 36.77m。
  `src/config.ts` の `GEOID_HEIGHT_M`（36.7）を引いて標高にする（23区内の誤差 0.1m 程度）。
- 建物の `_zmin` と国土地理院 5m メッシュ標高（dem5a）の差の中央値は 丸の内 −0.1m、渋谷 −0.3m（10m メッシュでは渋谷 −1.6m、ばらつき ±3m）。
- 東京は起伏がある（渋谷駅周辺 400m 以内で標高 11〜35m）ので地面は平面にしない。
  **地面は国土地理院 標高タイル（5m メッシュ、無効値は 10m メッシュで補う）で起伏を付ける**。
- 3D Tiles は ECEF を剛体変換するだけだと原点から離れるほど丸みで沈む（渋谷で約 3m）。
  `src/scene/plateau/buildings.ts` はタイルごとに、タイル中心を `latLonToLocal` の位置へ置き直す（タイル内の誤差 数cm）。
- 地面の高さが要るとき（物を地面に置くなど）は `PlateauGround.elevation.elevationAt(lat, lon)`（標高 m）を使う。

## 規約

- コミット前に `npm run typecheck`・`npm run lint`・`npm test`・`npm run test:e2e` をすべて通す。
- アプリは最初のフレーム描画後に `window.__APP_READY__ = true` を設定する。E2E はこれを待つ。
- コンソールエラー0件を保つ（E2E が検査する）。
- 作業ブランチは `claude/*`。PR のタイトル・本文は日本語。
