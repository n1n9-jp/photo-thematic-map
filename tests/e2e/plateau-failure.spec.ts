import { expect, test } from '@playwright/test';

// 配信サーバーに接続できないときに、要求を繰り返し続けず、読み込み完了（ready）まで進むことを確かめる。
test.setTimeout(180_000);

/** ready の後、要求が止まっていることを確かめるために観察を続ける時間(ms)。 */
const OBSERVE_MS = 12_000;

const CASES = [
  { name: '航空写真', pattern: /api\.plateauview\.mlit\.go\.jp\/tiles\//, statKey: 'groundFailed', maxRequests: 40 },
  { name: '標高', pattern: /cyberjapandata\.gsi\.go\.jp\/xyz\//, statKey: 'elevationFailed', maxRequests: 40 },
  { name: '建物 b3dm', pattern: /\.b3dm(\?|$)/, statKey: 'buildingsFailed', maxRequests: 60 },
] as const;

for (const c of CASES) {
  test(`${c.name}の取得に失敗しても、再試行に上限があり、読み込み完了まで進む`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

    let requests = 0;
    await page.route(c.pattern, async (route) => {
      requests++;
      await route.abort('failed');
    });

    await page.goto('/demos/plateau.html');
    await page.waitForFunction(() => window.__APP_READY__ === true, undefined, { timeout: 120_000 });
    const atReady = requests;
    await page.waitForTimeout(OBSERVE_MS);

    const stats = await page.evaluate(() => (window as unknown as { __PTM_STATS__: () => Record<string, number> }).__PTM_STATS__());
    console.log(`${c.name}: 要求 ${requests} 回（ready 時点 ${atReady} 回）、コンソールエラー ${errors.length} 件`, stats);

    expect(requests).toBeGreaterThan(0);
    expect(requests).toBeLessThanOrEqual(c.maxRequests);
    // ready の後は、失敗したタイルを要求し直し続けない
    expect(requests - atReady).toBeLessThanOrEqual(6);
    // 失敗した件数を外から読める
    expect(stats[c.statKey]).toBeGreaterThan(0);
    // コンソールエラーは、ブラウザが失敗した要求ごとに出すもの以外は出さない
    expect(errors.filter((e) => !e.includes('net::ERR_FAILED'))).toEqual([]);
    expect(errors.length).toBeLessThanOrEqual(requests);
  });
}
