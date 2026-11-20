/**
 * 取得したファイルのキャッシュ（`node_modules/.cache/ptm-bake/`）。
 * 同じ URL は2回目以降ネットワークに出ない。並列数を絞って取得する。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE_DIR = process.env.PTM_BAKE_CACHE ?? join(ROOT, 'node_modules/.cache/ptm-bake');

let networkFetches = 0;
let cacheHits = 0;
export function fetchCounts(): { network: number; cache: number } {
  return { network: networkFetches, cache: cacheHits };
}

function cachePath(url: string): string {
  const h = createHash('sha256').update(url).digest('hex');
  return join(CACHE_DIR, h.slice(0, 2), h);
}

/** キャッシュから消す。 */
export function dropCached(url: string): void {
  rmSync(cachePath(url), { force: true });
}

/** URL の中身を取得する（キャッシュあり）。404 は null を返す（allow404 のとき）。 */
export async function fetchCached(url: string, options: { allow404?: boolean } = {}): Promise<Uint8Array | null> {
  const p = cachePath(url);
  if (existsSync(p)) {
    cacheHits++;
    return new Uint8Array(readFileSync(p));
  }
  if (existsSync(`${p}.404`)) {
    cacheHits++;
    return null;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404 && options.allow404) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(`${p}.404`, '');
        networkFetches++;
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(`${p}.tmp`, buf);
      renameSync(`${p}.tmp`, p);
      networkFetches++;
      return buf;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`${url} の取得に失敗しました: ${String(lastErr)}`);
}

export async function fetchJsonCached<T>(url: string): Promise<T> {
  const b = await fetchCached(url);
  if (!b) throw new Error(`${url} が見つかりません`);
  return JSON.parse(new TextDecoder().decode(b)) as T;
}

/** 配列の各要素に非同期の処理を並列数 limit で適用する（結果は入力の順）。 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
