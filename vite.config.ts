import { globSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// index.html（本編）と demos/*.html（機能ごとの確認ページ）をすべてビルド対象にする。
const input = ['index.html', ...globSync('demos/*.html')];

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
