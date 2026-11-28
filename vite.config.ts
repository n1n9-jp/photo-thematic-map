import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { fillCoverTokens } from './src/story/content/cover.ts';

/** index.html の表紙の数値（`{{ptm:キー}}`）を facts.ts の値で埋める（src/story/content/cover.ts）。 */
const coverFacts = (): Plugin => ({
  name: 'ptm-cover-facts',
  transformIndexHtml: { order: 'pre', handler: (html) => fillCoverTokens(html) },
});

// index.html（本編）と demos/*.html（機能ごとの確認ページ）をすべてビルド対象にする。
// 実行時のカレントディレクトリに依存しないよう、プロジェクトのディレクトリ基準の絶対パスにする。
const root = import.meta.dirname;
const input = ['index.html', ...globSync('demos/*.html', { cwd: root })].map((f) => resolve(root, f));

export default defineConfig({
  base: './',
  // 本編と確認ページを別々の HTML として扱う。存在しないパスに index.html を返さない（404 にする）。
  appType: 'mpa',
  plugins: [coverFacts()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rolldownOptions: { input },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
