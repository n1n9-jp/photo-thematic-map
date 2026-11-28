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
| `npm run test:e2e` | 建物の事前変換（`data:buildings`）→ ビルド → preview 起動 → Playwright（`tests/e2e/`）。スクリーンショットは `screenshots/`（Playwright の `outputDir` である `test-results/` は実行開始時に消去されるため別にしている） |
| `npm run data:plateau` | PLATEAU データカタログから23区の建物 3D Tiles の URL を `public/data/plateau/tilesets.json` に書き出す |
| `npm run data:landmask` | 国土地理院の標高タイル（無効値＝海）から、海陸マスク `public/data/basemap/landmask.png` を作る（範囲は `src/geo/landmask.ts`。地面の下に敷く海の色の形に使う） |
| `npm run data:buildings` | 建物の事前変換。台本のカメラが巡る3か所の PLATEAU の建物・橋梁を、本編の座標の軽いチャンクにして `public/data/buildings/`（Git の管理外）に書き出す。入力（変換のコード・設定・台本のカメラ）が変わっていなければ何もしない。`-- --force` で作り直す。初回は PLATEAU からタイル（約5GB、数分）を取り `node_modules/.cache/ptm-bake/` にキャッシュする。`scripts/deploy/gh-pages.sh` と `test:e2e` が先に実行する |
| `npm run data:bicycles` | 放置自転車の統計から `public/data/bicycles/*.json` を作る（原本の取得方法は `data/raw/bicycles/SOURCES.md`） |

E2E は `/opt/pw-browsers/chromium` を使う。preview サーバーのポートは環境変数 `E2E_PORT`（既定 4173）で変えられ、既存のサーバーは再利用しない。別の場所の Chrome を使うときは環境変数 `CHROMIUM_PATH` で指定する。ヘッドレス WebGL は SwiftShader のソフトウェア描画（起動オプションは `playwright.config.ts`）。

## ディレクトリ構成

- `src/scene/` 描画（renderer・シーン・カメラ・PLATEAU 表示）
  - `src/scene/plateau/` PLATEAU の街並み。`stage.ts`（舞台一式）、`bakedBuildings.ts`（変換済みの建物。本編の既定）、`buildings.ts`（建物 3D Tiles を直接読む。確認ページ demos/plateau と本編の `?buildings=live`）、`ground.ts`（地面。国土地理院の標高タイルで起伏を付けた単色の面。航空写真は使わない。下記「地面」）、`elevation.ts`（標高）、`catalog.ts`（tileset 一覧）、`attribution.ts`（出典表示）、`tileFetch.ts`（タイル取得の再試行と失敗の集計）、`budget.ts`（端末に合わせたメモリの上限）、`baseGround.ts`（起伏の付いた地面の下に敷く平らな地面と海、地面の陸と海の色。起伏の付いた地面のない範囲を空の色で抜かさない）
- `src/data/` 生成データの形式と読み込み（`grids.ts` 街の高さ格子、`buildings.ts` 変換済みの建物のチャンク）
- `src/geo/` 座標変換（`enu.ts`）
- `src/sim/` 堆積計算（描画に依存しない純粋ロジック）
- `src/story/` スクロール連動。表紙（`index.html` の `.ptm-cover`、`cover.css`・`cover.ts`、数値は `content/cover.ts`）は `docs/design/cover/README.md`
- 街の上の地名（案内の文字）: データは `src/story/content/placeNames.ts`（場面ごとの一覧と、座標の根拠の表 `docs/design/place-labels/README.md`）、表示は `src/scene/placeLabels.ts`、本編への組み込みは `src/app/placeLabelsLayer.ts`。場面のモジュールは、地名を重ねない主役の形を `labelKeepOut()` で返す（`src/app/sceneModule.ts`）。駅のラベル（台数のデータ、墨の札）とは別の見た目（札なしの墨の文字に紙の色の縁取り、`--ptm-place-*`）で、スクリーンリーダーには読ませない（`aria-hidden`）
- `src/config.ts` 共有定数（座標原点など）
- `src/styles/tokens.css` デザイントークン（色・書体・文字サイズ・余白・角丸・罫線・影）。本文カード・ボタン・出典表示・読み込みの表示・凡例とラベル・街の上の地名・「データと方法」は、値を直接書かずにここの `--ptm-*` を参照する。数字と欧文の書体は同梱の Inter（`@fontsource-variable/inter`、OFL-1.1）
- `scripts/` データ取得スクリプト（Node 実行。成果物は `public/` 等へ出力）。`scripts/bake/` は PLATEAU のタイルの取得・復号（`tiles.ts`・`cache.ts`）と、街の高さ格子（`index.ts`）・建物の事前変換（`buildings.ts`）
- `tests/unit/` vitest、`tests/e2e/` Playwright
- `public/` 静的アセット

## 機能ごとの確認ページ（demos）

機能は本編（`index.html`・`src/main.ts`）に組み込む前に、単独で動く確認ページとして作る。本編への統合はオーケストレータが行う。

- ページ: `demos/<機能名>.html`（`<script type="module" src="/src/demos/<機能名>.ts">` を読み込む）
- エントリ: `src/demos/<機能名>.ts`
- E2E: `tests/e2e/<機能名>.spec.ts`（`/demos/<機能名>.html` を開き、`__APP_READY__` とコンソールエラー0件を確認し、`screenshots/<機能名>.png` を保存する）
- `vite.config.ts` が `demos/*.html` を自動でビルド対象に含めるので、設定の変更は不要。
- 機能の本体は `src/scene/` `src/sim/` `src/story/` に再利用できるモジュールとして置き、確認ページからはそれを呼ぶだけにする。

## 地面

地面に航空写真は使わない（PLATEAU-Ortho も国土地理院の写真も読まない）。`tests/e2e/ground.spec.ts` が、本編の8場面を巡っても航空写真のタイルを要求しないことを確かめ、各場面を PC 幅とスマートフォン幅で `screenshots/ground/` に撮る。変更の前後の画面は `docs/design/ground/`。

- `src/scene/plateau/ground.ts` が、標高タイルの四分木（ズーム10〜18。標高は 5m メッシュまでなので、これより細かくしても形と陰影はほぼ変わらない）でカメラからの距離に応じた細かさのメッシュを作る。タイルの画面上の大きさが 256px × `detailScale`（`budget.ts` の `groundDetailScale`。パソコン 1.5・スマートフォン 2）を超えたら子に分ける。
- 標高タイルを取得するのはズーム15まで（ズーム14まで 10m メッシュ、ズーム15 で 5m メッシュ）。より細かいタイルは祖先の標高を使う。
- 色は `baseGround.ts` の `BASE_LAND_COLOR`（陸）と `BASE_SEA_COLOR`（海）。各タイルに、陸の色に標高の傾きから求めた控えめな陰影（`RELIEF_STRENGTH`・`RELIEF_EXAGGERATION`。光はシーンの太陽と同じ西南西の上から）を掛けた小さな画像を貼る。標高の無効値（海）は透明にし、下の海の面が見える。陰影の傾きは同じ標高タイルの画素どうしで求める（5m と 10m の境に線を出さない）。
- 標高タイルを取得できなかった（回線の失敗など）タイルは、祖先の標高（無ければ 0m）で不透明な地面を作って表示し、`retryFailedTiles()` で作り直す。存在しない標高タイル（404）は海とみなす。

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
- 文字の載る UI の色・行間・文字サイズ・余白・角丸・影は `src/styles/tokens.css` の `--ptm-*` で書き、値を直接書かない。例外は配置の計算と結び付いた寸法（凡例の幅 292・430・218px と配置の余白、本文カードの配置の変数 `--story-*`、ボタンや表示の `top`・`right` など画面の端からの位置）と、データの色（駅の柱・凡例の色の段階 `COLOR_STEPS`・`VACANCY_COLORS`）。hover の色は `@media (hover: hover)` の中に書き、フォーカスの輪は `--ptm-focus-ring` を要素の影に重ねる（強制カラーで見えるよう、透明の `outline` を持たせる）。
- 作業ブランチは `claude/*`。PR のタイトル・本文は日本語。
