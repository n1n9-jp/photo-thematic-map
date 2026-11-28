# 表紙（冒頭のタイトル画面）

本編（`index.html`）の最初の1画面。題名・副題・リード文・データの出典と調査年度・非公式の作品であることの注記と、スクロールの合図を置く。

- 文は `index.html` に静的に書き、JavaScript と 3D の読み込みを待たずに出る。数値だけ `{{ptm:キー}}` と書き、ビルド時に `vite.config.ts` のプラグインが `src/story/content/cover.ts`（`facts.ts` から組み立てる）の値で埋める。
- 見た目は `src/story/cover.css`。値はすべて `src/styles/tokens.css` の `--ptm-*` を参照し、面・輪郭線と影・角丸・書体・文字サイズの段階・余白・フォーカスの輪・リンクは本文カード（`src/story/story.css`）と同じ規則にしている。`tokens.css` は `cover.css` の `@import` で読み、`index.html` の head から最初の描画で効く。題名は段階のいちばん大きな見出し（PC 52px・スマートフォン 40px・低い画面 30px）、副題・リード文・出典の順に大きさ・太さ・色（`--ptm-ink-1`〜`3`）で階層を下げる。画面の大きさで変わる値は先頭の `--cover-*` にまとめてある。
- 表紙は普通にスクロールして上へ抜ける。場面1の進捗 0 は「`#story` の上端が画面の上端に来た位置」（`src/story/storyScroll.ts`）なので、表紙のぶんだけ後ろにずれるだけで、場面1以降の進み方は変わらない。表紙の間は場面1の進捗 0（カメラは場面1の位置）。
- リサイズ・回転でレイアウトを計算し直すときは、表紙の途中にいた読者は表紙の中での同じ割合へ、場面1の始まり以降は同じ場面と進捗へ、最後の場面の後（「データと方法」の節）は最後の場面の終わりからの同じ距離へ戻す（`storyScroll.ts`）。
- `#data-and-methods` などのページ内リンク付きの URL で開いたときは、本文を組んでレイアウトを計算し直した後に、その要素へ移る（読み込みの間に読者がスクロールし始めたら移らない。`src/main.ts`）。
- パネルが右上の読み込みの表示と横に重なる配置（スマートフォンの縦向き）では、パネルはその表示に届く前に薄くなって消える（`src/story/cover.ts`）。パネルの中にフォーカスがある間は、不透明で出す。

## スクリーンショット

`tests/e2e/cover.spec.ts` が `screenshots/cover/` に書き出したものを写した（SwiftShader の描画。撮影したのは地面に航空写真を貼っていたころで、いまの地面は起伏の付いた単色の面）。

| 画面 | 表紙 | 移る途中（表紙の高さの 25%・50%） |
| --- | --- | --- |
| PC 1280×720 | `pc-cover.png` | `pc-transition-25.png` `pc-transition-50.png` |
| スマートフォン 390×844 | `phone-cover.png` | `phone-transition-25.png` `phone-transition-50.png` |
| 小さいスマートフォン 320×568 | `phone-small-cover.png` | `phone-small-transition-25.png` `phone-small-transition-50.png` |
| スマートフォンの横向き 844×390 | `landscape-cover.png` | `landscape-transition-25.png` `landscape-transition-50.png` |
| タブレットの縦向き 768×1024 | `tablet-cover.png` | `tablet-transition-25.png` `tablet-transition-50.png` |
