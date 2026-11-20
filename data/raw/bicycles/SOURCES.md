# 放置自転車データの出典（原本）

取得日はすべて **2026-11-20**（この環境から `curl` で取得）。SHA-256 は取得したファイルそのもののハッシュです。

## 変換スクリプトが読む原本

東京都の原本（Excel・PDF・報道発表の HTML）と、そのページ抽出（`extracts/`）は、都のサイトポリシーに配慮してリポジトリに含めていません（.gitignore 対象）。`npm run data:bicycles` を実行するには、下の URL から取得してこのディレクトリに置き、SHA-256 で同一性を確かめてください。国土数値情報（`n02/`、CC BY 4.0）と手で転記した数値（`transcribed/`）はリポジトリに含めています。

| ファイル | 資料名 | 取得元 URL | SHA-256 |
| --- | --- | --- | --- |
| `07ekibetsuhouchi.xlsx` | 駅前放置自転車等の現況と対策 －令和７年度調査－ （4）駅別放置自転車、原動機付自転車及び自動二輪車の状況（Excel） | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07ekibetsuhouchi | `7e11b4ba1de71bf1104d373e31f67a7c8a521d70d626e131e6f6aaad2cfe3465` |
| `20260326_24_03a.pdf` | 「駅前放置自転車等の現況と対策－令和７年度調査－」について －調査結果の概要－（報道発表の別紙、3ページ） | https://www.metro.tokyo.lg.jp/documents/d/tosei/20260326_24_03a | `2e256fa4468c43eff9e66a63a19520ee20046accfd15786c8244cbb184a7b46a` |
| `202603_jitensyagaiyou_summary.pdf` | 同上（都民安全総合対策本部のページ掲載版。テキストは上と同一） | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202603_jitensyagaiyou_summary | `47ad98bea457b7403b05b099a8bfab3e8b354df9bdbaf472021837c50f87f565` |
| `press_2026032616.html` | 東京都 報道発表「駅前放置自転車等の現況と対策」調査結果（2026年3月26日） | https://www.metro.tokyo.lg.jp/information/press/2026/03/2026032616 | `754072c0a2f1699af65869dffd8f2cc5683df50006f11bbe5e1fb216d314d049` |
| `n02/N02-24_Station.geojson` | 国土数値情報 鉄道データ（N02、2024年度）駅（`N02-24_GML.zip` 内 `UTF-8/N02-24_Station.geojson` を無加工で取り出したもの） | https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip | `f88168b3a9199a632705df445209c02456005574c1b28e6d78d62171f42c450a` |
| `n02/KS-META-N02-24.xml` | 同上のメタデータ（zip 内） | 同上 | `db58c1d8165e505852da96a902bb9b4f3e8b7a192b98f448f017f634479ae6c2` |

一覧ページ: 東京都 都民安全総合対策本部「都内における駅前放置自転車の現況」 https://www.tomin-anzen.metro.tokyo.lg.jp/kotsu/jitensha/houchi/0000001962 （更新日 2026年3月27日。平成23年度〜令和７年度の各年度の概要 PDF・全文 PDF・駅別 Excel へのリンクがある）

## リポジトリに含めないファイル（`large/`、.gitignore 対象）

容量が大きいため、`data/raw/bicycles/large/` に置いてコミットしません。変換スクリプトはこれらを読みません。必要なページはテキスト抽出（`extracts/`）としてコミットしています。再取得は下の URL から行い、SHA-256 で同一性を確かめてください。

| ファイル | 資料名 | 取得元 URL | SHA-256 |
| --- | --- | --- | --- |
| `202603_jitensyagenkyo.pdf`（63.5MB、179ページ） | 駅前放置自転車等の現況と対策 －令和７年度調査－（全文） | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202603_jitensyagenkyo | `f9d01731ebf14d3fddf91a8ed14de90fa74cb59f6cdaec12b870acb120044488` |
| `N02-24_GML.zip`（12.7MB） | 国土数値情報 鉄道データ（N02、2024年度） | https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip | `504eefd4411cd0fd3ad9a50f35da2f5da07949d5144ded7630df0972f8deaac7` |
| `07_jitensyagenkyo2.pdf` | 同（全文）－平成23年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo2 | `21836a55e79c25a1f5517db96aaada07d53417b0dd7208d398c996e1f7f264bb` |
| `07_jitensyagenkyo242.pdf` | 同 －平成24年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo242 | `7c64fb3aa01e94481a24169fa34e5ba5d53afa0f20495c4247a7d80159675fb2` |
| `07_jitensyagenkyo252.pdf` | 同 －平成25年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo252 | `64023596875c77ac11621c14de3c30d507cff07b20115fcf714c763e5cedf683` |
| `07_jitensyagenkyo263.pdf` | 同 －平成26年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo263 | `141b94baf1b372a868269fbb9f08cb26ba604b60745f10f3e0d1a2fc79bd2410` |
| `07_jitensyagenkyo273.pdf` | 同 －平成27年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo273 | `2605ab0adf24acf7bff80b2c5c0e0dcbd8a234eb245f73f365244003204abb85` |
| `jitenshagenkyo28.pdf` | 同 －平成28年度調査－（画像のみの PDF） | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/jitenshagenkyo28 | `a1a04310eed4390f20ec49335f92d62d69e8ef030243cc0ca9fa67b94d3b8564` |
| `07_jitensyagenkyo293.pdf` | 同 －平成29年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07_jitensyagenkyo293 | `efd9438a503f7260e090444af1c1523a37f6389ab8bd1eba941dd94722473fdc` |
| `08_jitensyagenkyo293.pdf` | 同 －平成30年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/08_jitensyagenkyo293 | `8513b7e11f9592e729384ec9fd8ab6a41b28bb1335602f2a007de625ead91699` |
| `09_jitensyagenkyo293.pdf` | 同 －令和元年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/09_jitensyagenkyo293 | `f03d4189e5c926ac08a9e43ba11c0c30edf7c48bc27d065cb7f44854482a2e03` |
| `10_jitensyagenkyo293.pdf` | 同 －令和２年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/10_jitensyagenkyo293 | `da46924d02575224c0e266d1367f9c205408e95c6d3a6f6ba6509c78c0c9c30c` |
| `11_jitensyagenkyo033.pdf` | 同 －令和３年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/11_jitensyagenkyo033 | `ff0413701382af6d5a5c273e46ec9140e7e50f696d634004909178458ec6bbeb` |
| `202303_jitensyagenkyo02.pdf` | 同 －令和４年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202303_jitensyagenkyo02 | `64aa51d9d6383acb526f0b04079beb412dd109dca1be5c996b3960fb3b155793` |
| `202403_jitensyagenkyo.pdf` | 同 －令和５年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202403_jitensyagenkyo | `3cc1eb6b352229e2c5aa384944e46c1fc447d00e099a0afdeddd008bc77a3f19` |
| `202503_jitensyagenkyo.pdf` | 同 －令和６年度調査－ | https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202503_jitensyagenkyo | `d5a56d13af236b7c6e424def668fd499a5eccd5cd3377a7b57d45408aa3a8c5e` |

## 原本から作った中間ファイル（`extracts/` は含めない、`transcribed/` は含める）

- `extracts/*.txt` … 上の PDF の該当ページを `pdftotext -layout -f N -l N`（poppler）でテキストにしたもの。ファイル名の `physNNN` は PDF の物理ページ番号（印刷されたページ番号ではない）。
  - `report-R07_phys005.txt`〜`phys006` 凡例（用語の定義・調査方法・集計方法）＝印刷 p.-（凡例）
  - `report-R07_phys009.txt` 第1-1-(1) 放置台数の推移の説明 ＝ p.3
  - `report-R07_phys012.txt` 第1-1-(2) 放置自転車が100台以上ある駅数 ＝ p.6
  - `report-R07_phys013.txt` 第1-1-(3) 区市町村別の放置台数 ＝ p.7
  - `report-R07_phys028.txt` 第1-1-(5) 放置台数が多い駅 ＝ p.22
  - `report-R07_phys032.txt`・`phys033` 第1-1-(8) 乗入台数・実収容台数・放置台数の推移 ＝ p.26-27
  - `report-R07_phys034.txt` 第1-2-(1)(2) 自転車等駐車場数・収容能力の推移 ＝ p.28
  - `report-R07_phys056.txt` 第1-3-(1)(2) 撤去・返還・処分の推移と処分内訳 ＝ p.50
  - `removal_FY{年度}_report-{調査年度}_phys{NNN}.txt` 各年度の全文の「区市町村の撤去・返還・処分状況」（令和７年度調査では p.51）
  - `report-R07_gaiyou-summary.txt` 概要 PDF の全文
- `extracts/removal_FY2015_report-H28_phys056.png` … 平成28年度調査の全文は画像のみの PDF のため、該当ページを `pdftoppm -r 110 -gray` で画像にしたもの（上部の表部分）。
- `transcribed/tokyo_trend_R07_p26-27.csv` … p.26-27 の表の「都」の行を手で転記。変換スクリプトが「実収容＋放置＝乗入」を全年で検算する。
- `transcribed/removal_FY2015_report-H28_p50.csv` … 上の画像から平成27年度の総数行を目視で転記。

## 利用条件

### 東京都（Excel・PDF・報道発表）

- 都民安全総合対策本部サイトポリシー https://www.tomin-anzen.metro.tokyo.lg.jp/policy （更新日 2026年2月18日）「第1 著作権（クリエイティブコモンズライセンスを使用しない場合）」: 掲載情報は著作権の対象で、「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできない。
- 都庁総合ホームページのサイトポリシー https://www.metro.tokyo.lg.jp/policy （著作権・リンクについては同サイトの「著作権・リンクについて」のページ）。
- 上記の資料ページには CC ライセンスの表示は見当たらなかった。作品で使う統計の数値そのもの（事実）と出典の明記は問題になりにくいが、**原本ファイル（Excel・PDF・HTML）を公開リポジトリに置いて再配布することは、上記の「無断で複製・転用することはできない」に当たる可能性がある**。リポジトリを公開する前に、原本をコミットしたままにするか判断が必要。

### 国土数値情報（N02 鉄道データ）

- 「このデータの使用許諾条件」: 2020年（令和2年）以降のデータは **オープンデータ（CC BY 4.0）**（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html ）。
- 国土数値情報ダウンロードサイト 利用規約 https://nlftp.mlit.go.jp/ksj/other/agreement.html （公共データ利用規約 第1.0版（PDL1.0）を適用。利用時は出典を記載し、加工した場合は加工した旨を記載する）。
- 作品での出典表記の例: 「国土数値情報（鉄道データ）（国土交通省）を加工して作成」。
- 測地系は JGD2011（緯度経度）。WGS84 との差は作品の用途では無視できる（数 cm 程度）。
