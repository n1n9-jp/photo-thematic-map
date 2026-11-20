import { writeFileSync } from 'node:fs';
import { test } from '@playwright/test';

/**
 * 自転車の大量描画の計測。通常の E2E では実行しない（BICYCLE_BENCH=1 のときだけ）。
 *   BICYCLE_BENCH=1 npx playwright test tests/e2e/bicycles-bench.spec.ts --trace off
 * 結果は screenshots/bicycle-bench.json と標準出力の表。
 * ヘッドレス Chromium のソフトウェア描画（SwiftShader）では絶対値に意味はなく、台数どうしの相対比較に使う。
 */
const COUNTS = [10_000, 100_000, 500_000];
const CASES = [
  { view: 'heap', buried: 'far' },
  { view: 'heap', buried: 'hidden' },
  { view: 'parked', buried: 'far' },
];

test.skip(!process.env.BICYCLE_BENCH, 'BICYCLE_BENCH=1 のときだけ実行する');
test.describe.configure({ timeout: 1_800_000 });

test('自転車の大量描画を計測する', async ({ page }) => {
  const rows: Record<string, unknown>[] = [];
  for (const c of CASES) {
    for (const count of COUNTS) {
      const t0 = Date.now();
      await page.goto(`/demos/bicycles.html?view=${c.view}&buried=${c.buried}&count=${count}&bench=1&benchMs=3000`);
      await page.waitForFunction(() => window.__BENCH__ !== undefined, undefined, { timeout: 900_000, polling: 1000 });
      const r = await page.evaluate(() => window.__BENCH__!);
      rows.push({ ...r, buried: c.buried, wallMs: Date.now() - t0 });
      console.log(JSON.stringify(rows[rows.length - 1]));
    }
  }
  writeFileSync('screenshots/bicycle-bench.json', JSON.stringify(rows, null, 2));
  console.log('| 視点 | 内部 | 台数 | 描画三角形 | 近/中/遠 | FPS | ms/frame | 配置+登録ms |');
  for (const r of rows as { view: string; buried: string; count: number; triangles: number; perLod: number[]; fps: number; setupMs: number }[]) {
    console.log(
      `| ${r.view} | ${r.buried} | ${r.count.toLocaleString('en-US')} | ${r.triangles.toLocaleString('en-US')} | ${r.perLod.join('/')} | ${r.fps.toFixed(2)} | ${(1000 / r.fps).toFixed(0)} | ${r.setupMs.toFixed(0)} |`,
    );
  }
});

test('187,262台を登録した状態で、表示台数の切り替えと転送量を計測する', async ({ page }) => {
  const rows: Record<string, unknown>[] = [];
  for (const q of ['view=heap', 'view=heapdetail', 'view=heap&far=1']) {
    await page.goto(`/demos/bicycles.html?${q}&count=187262&bench=reveal`);
    await page.waitForFunction(() => window.__BENCH__ !== undefined, undefined, { timeout: 900_000, polling: 1000 });
    const r = await page.evaluate(() => window.__BENCH__!);
    rows.push({ query: q, ...r });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  writeFileSync('screenshots/bicycle-reveal-bench.json', JSON.stringify(rows, null, 2));
});
