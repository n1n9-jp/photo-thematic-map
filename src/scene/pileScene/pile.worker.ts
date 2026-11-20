/**
 * 山の場面の計算を行う Web Worker（`computePileInWorker` が起動する）。
 * 街の高さ格子（地表の高さだけ）を読み、`computePileScene` の結果を転送で返す。
 */
import { bytesToUint16, dequantizeHeights, gridMetaPath, type GridMeta } from '../../data/grids';
import type { HeightGrid } from '../../sim/heightGrid';
import { computePileScene, transferablesOf, type PileComputeParams } from './compute';
import type { PileWorkerRequest, PileWorkerResponse } from './workerProtocol';

const ctx = self as unknown as {
  postMessage(message: PileWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<PileWorkerRequest>) => void) | null;
};

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗しました（HTTP ${res.status}）`);
  return res;
}

/** 格子の地表の高さ（屋上を含む）だけを読む。publicRoot は公開ルートの絶対 URL。 */
async function loadSurface(publicRoot: string, name: string): Promise<HeightGrid> {
  const meta = (await (await fetchOk(new URL(gridMetaPath(name), publicRoot).href)).json()) as GridMeta;
  const bytes = new Uint8Array(await (await fetchOk(new URL(meta.files.height.path, publicRoot).href)).arrayBuffer());
  return {
    width: meta.width,
    height: meta.height,
    cellSize: meta.cellSize,
    originX: meta.originX,
    originZ: meta.originZ,
    data: dequantizeHeights(bytesToUint16(bytes), meta.quantization.height),
  };
}

ctx.onmessage = (ev) => {
  const { id, grid, publicRoot, params } = ev.data;
  void (async () => {
    try {
      ctx.postMessage({ id, type: 'progress', progress: { phase: 'load', fraction: 0 } });
      const t0 = performance.now();
      const surface = await loadSurface(publicRoot, grid);
      const loadMs = performance.now() - t0;
      const result = computePileScene(surface, params as PileComputeParams, (progress) => ctx.postMessage({ id, type: 'progress', progress }), loadMs);
      ctx.postMessage({ id, type: 'done', result }, transferablesOf(result));
    } catch (err) {
      ctx.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
