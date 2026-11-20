import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { serveUnderPrefix, type StaticServer } from './helpers/staticServer';

const DIST = resolve(import.meta.dirname, '../../dist');
const SAMPLE = { name: 'sample', values: [1, 2, 3] };

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    // 404 の確認で意図的に失敗させたリクエストは、ブラウザが console.error として記録する
    if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 30_000 });
}

/** ビルド済みの確認ページが読み込むスクリプトの URL（ページ基準で解決済み）。 */
async function builtPathsScriptUrl(pageUrl: string): Promise<string> {
  const html = await readFile(resolve(DIST, 'demos/paths.html'), 'utf8');
  const src = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
  if (!src) throw new Error('dist/demos/paths.html に module script が見つかりません');
  return new URL(src, pageUrl).href;
}

test('確認ページ(/demos/)から public/data/sample.json を読め、存在しないパスは 404', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/demos/paths.html');
  await waitReady(page);

  const r = await page.evaluate(() => window.__PATHS_RESULT__);
  expect(r?.sample).toEqual(SAMPLE);
  expect(r?.missingStatus).toBe(404);
  // /demos/data/... ではなく公開ルートの /data/... を指す
  expect(new URL(r?.sampleUrl ?? '').pathname).toBe('/data/sample.json');

  await page.screenshot({ path: 'screenshots/paths.png' });
  expect(errors).toEqual([]);
});

test('本編(/)の位置から同じモジュールを実行しても同じ JSON を読める', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitReady(page);

  // assetUrl はページの URL ではなくモジュールの位置を基準にするので、本編のページから実行しても結果は変わらない
  const script = await builtPathsScriptUrl(page.url());
  await page.evaluate(async (src) => {
    await import(/* @vite-ignore */ src);
  }, script);

  const r = await page.evaluate(() => window.__PATHS_RESULT__);
  expect(r?.sample).toEqual(SAMPLE);
  expect(r?.missingStatus).toBe(404);
  expect(new URL(r?.sampleUrl ?? '').pathname).toBe('/data/sample.json');
  expect(errors).toEqual([]);
});

test.describe('サブパス /photo-thematic-map/ で配信した dist', () => {
  const PREFIX = '/photo-thematic-map/';
  let server: StaticServer;

  test.beforeAll(async () => {
    server = await serveUnderPrefix(DIST, PREFIX);
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('確認ページから JSON を読め、存在しないパスは 404', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`${server.origin}${PREFIX}demos/paths.html`);
    await waitReady(page);

    const r = await page.evaluate(() => window.__PATHS_RESULT__);
    expect(r?.sample).toEqual(SAMPLE);
    expect(r?.missingStatus).toBe(404);
    expect(new URL(r?.sampleUrl ?? '').pathname).toBe(`${PREFIX}data/sample.json`);
    expect(errors).toEqual([]);
  });

  test('本編(サブパス)が起動し、favicon も読める', async ({ page }) => {
    const errors = collectErrors(page);
    const failed: string[] = [];
    page.on('response', (res) => {
      if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
    });
    await page.goto(`${server.origin}${PREFIX}`);
    await waitReady(page);
    await expect(page.locator('canvas')).toHaveCount(1);
    expect(failed).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('確認ページの favicon（ルート絶対パス指定）がサブパスでも読める', async ({ page }) => {
    const failed: string[] = [];
    page.on('response', (res) => {
      // 確認ページ自身が 404 の確認のために読む does-not-exist.json は除く
      if (res.status() >= 400 && !res.url().endsWith('/does-not-exist.json')) {
        failed.push(`${res.status()} ${res.url()}`);
      }
    });
    await page.goto(`${server.origin}${PREFIX}demos/paths.html`);
    await waitReady(page);
    expect(failed).toEqual([]);
    const href = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(new URL(href ?? '', page.url()).pathname).toBe(`${PREFIX}favicon.svg`);
  });
});
