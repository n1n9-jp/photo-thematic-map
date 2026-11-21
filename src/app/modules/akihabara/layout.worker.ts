/**
 * 秋葉原の配置を計算する Web Worker（`computeAkihabaraInWorker` が起動する）。
 * 街の高さ格子 `akihabara` を読み、`computeAkihabaraLayout` の結果を転送で返す。
 */
import { cityGridFromBytes, gridMetaPath, type GridMeta } from '../../../data/grids';
import { computeAkihabaraLayout } from './layout';
import type { AkihabaraWorkerRequest, AkihabaraWorkerResponse } from './workerProtocol';

const ctx = self as unknown as {
  postMessage(message: AkihabaraWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<AkihabaraWorkerRequest>) => void) | null;
};

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗しました（HTTP ${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}

ctx.onmessage = (ev) => {
  const { id, publicRoot, count } = ev.data;
  void (async () => {
    try {
      const t0 = performance.now();
      const metaRes = await fetch(new URL(gridMetaPath('akihabara'), publicRoot).href);
      if (!metaRes.ok) throw new Error(`格子 akihabara のメタ情報の取得に失敗しました（HTTP ${metaRes.status}）`);
      const meta = (await metaRes.json()) as GridMeta;
      const [height, ground, classes] = await Promise.all([
        fetchBytes(new URL(meta.files.height.path, publicRoot).href),
        fetchBytes(new URL(meta.files.ground.path, publicRoot).href),
        fetchBytes(new URL(meta.files.class.path, publicRoot).href),
      ]);
      const grid = cityGridFromBytes(meta, { height, ground, classes });
      const loadMs = performance.now() - t0;
      const result = computeAkihabaraLayout(grid, count);
      const l = result.layout;
      ctx.postMessage({ id, type: 'done', result, loadMs }, [
        l.positions.buffer,
        l.yaws.buffer,
        l.rolls.buffer,
        l.widths.buffer,
        l.pathDistances.buffer,
        l.rows.buffer,
      ] as Transferable[]);
    } catch (err) {
      ctx.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
