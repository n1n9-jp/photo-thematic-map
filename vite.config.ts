import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// index.html（本編）と demos/*.html（機能ごとの確認ページ）をすべてビルド対象にする。
// 実行時のカレントディレクトリに依存しないよう、プロジェクトのディレクトリ基準の絶対パスにする。
const root = import.meta.dirname;
const input = ['index.html', ...globSync('demos/*.html', { cwd: root })].map((f) => resolve(root, f));

export default defineConfig({
  base: './',
  // 本編と確認ページを別々の HTML として扱う。存在しないパスに index.html を返さない（404 にする）。
  appType: 'mpa',
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
