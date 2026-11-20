import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'tests/e2e',
  // Playwright は実行開始時に outputDir を消去する。スクリーンショットは別の screenshots/ に保存する。
  outputDir: 'test-results',
  timeout: 60_000,
  reporter: 'list',
  workers: process.env.CI ? 1 : 2,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: CHROMIUM_PATH,
      // ヘッドレス環境ではソフトウェア描画(SwiftShader)で WebGL を動かす
      args: [
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
