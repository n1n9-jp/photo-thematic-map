# 表紙（冒頭のタイトル画面）

本編（`index.html`）の最初の1画面。題名・副題・リード文・データの出典と調査年度・非公式の作品であることの注記と、スクロールの合図を置く。

- 文は `index.html` に静的に書き、JavaScript と 3D の読み込みを待たずに出る。数値だけ `{{ptm:キー}}` と書き、ビルド時に `vite.config.ts` のプラグインが `src/story/content/cover.ts`（`facts.ts` から組み立てる）の値で埋める。
- 見た目は `src/story/cover.css`。色・書体・余白は先頭の `--cover-*` 変数にまとめてある。
- 表紙は普通にスクロールして上へ抜ける。場面1の進捗 0 は「`#story` の上端が画面の上端に来た位置」（`src/story/storyScroll.ts`）なので、表紙のぶんだけ後ろにずれるだけで、場面1以降の進み方は変わらない。表紙の間は場面1の進捗 0（カメラは場面1の位置）。
- パネルが右上の読み込みの表示と横に重なる配置（スマートフォンの縦向き）では、パネルはその表示に届く前に薄くなって消える（`src/story/cover.ts`）。

## スクリーンショット

`tests/e2e/cover.spec.ts` が `screenshots/cover/` に書き出したものを写した（SwiftShader の描画。航空写真は読み込みの途中のことがある）。

| 画面 | 表紙 | 移る途中（表紙の高さの 25%・50%） |
| --- | --- | --- |
| PC 1280×720 | `pc-cover.png` | `pc-transition-25.png` `pc-transition-50.png` |
| スマートフォン 390×844 | `phone-cover.png` | `phone-transition-25.png` `phone-transition-50.png` |
| 小さいスマートフォン 320×568 | `phone-small-cover.png` | `phone-small-transition-25.png` `phone-small-transition-50.png` |
| スマートフォンの横向き 844×390 | `landscape-cover.png` | `landscape-transition-25.png` `landscape-transition-50.png` |
| タブレットの縦向き 768×1024 | `tablet-cover.png` | `tablet-transition-25.png` `tablet-transition-50.png` |
