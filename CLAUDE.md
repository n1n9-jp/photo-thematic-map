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
| `npm run data:plateau` | PLATEAU データカタログから23区の建物 3D Tiles の URL を `public/data/plateau/tilesets.json` に書き出す |
| `npm run data:bicycles` | 放置自転車の統計から `public/data/bicycles/*.json` を作る（原本の取得方法は `data/raw/bicycles/SOURCES.md`） |

E2E は `/opt/pw-browsers/chromium` を使う。preview サーバーのポートは環境変数 `E2E_PORT`（既定 4173）で変えられ、既存のサーバーは再利用しない。別の場所の Chrome を使うときは環境変数 `CHROMIUM_PATH` で指定する。ヘッドレス WebGL は SwiftShader のソフトウェア描画（起動オプションは `playwright.config.ts`）。

## ディレクトリ構成

- `src/scene/` 描画（renderer・シーン・カメラ・PLATEAU 表示）
  - `src/scene/plateau/` PLATEAU の街並み。`stage.ts`（舞台一式）、`buildings.ts`（建物 3D Tiles）、`ground.ts`（航空写真の地面）、`elevation.ts`（標高）、`catalog.ts`（tileset 一覧）、`attribution.ts`（出典表示）、`tileFetch.ts`（タイル取得の再試行と失敗の集計）、`budget.ts`（端末に合わせたメモリの上限）
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
- 原点は `src/config.ts` の `ORIGIN`（既定: 東京駅 緯度 35.68124 / 経度 139.76712 / 標高 0）。ローカル Y=0 が標高 `ORIGIN.alt`（＝標高 0m）。
- 緯度経度（度）とローカル座標の変換は必ず `src/geo/enu.ts` の `latLonToLocal` / `localToLatLon` を使う。別実装を作らない。
- ENU との対応: `x = east`, `y = up`, `z = -north`。
- **ローカル座標は平らな地図**。水平（X・Z）は原点の曲率半径を使う局所近似（等距離円筒）、高さ（Y）は標高そのもので、地球の丸みは持たない。同じ標高の地点は、原点からどれだけ離れても同じ Y になる。
- 水平の近似は、原点から南北に離れるほど東西の縮尺がずれる（南北 20km で約 0.2%）。場面の舞台（秋葉原・丸の内・皇居外苑。原点から 2.5km 以内）では数 cm〜十数 cm。
- `enu.ts` の `ecefToTangentMatrix()`（旧名 `ecefToLocalMatrix()` は非推奨の別名）・`geodeticToEcef()`・`ecefToGeodetic()` は、原点で楕円体に接する厳密な ENU（剛体変換）。楕円体の計算は `src/geo/ecef.ts` に一本化してある。原点から数 km 以内のデータ（高さ格子の焼き込みなど）を載せる補助で、Y は楕円体高になり、離れると丸みのぶん下がる（2km で約 0.3m）。平らな地図へ直すときは `GEOID_HEIGHT_M` を引く。街並みの表示は下記のタイルごとの置き直しを使う。

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
