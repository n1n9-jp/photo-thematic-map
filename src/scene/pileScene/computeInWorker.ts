/**
 * 山の場面の計算を Web Worker で行う（主スレッドを止めない）。
 * 結果の TypedArray は転送（コピーなし）で受け取る。
 */
import { assetUrl } from '../../paths';
import type { PileComputeParams, PileComputeProgress, PileComputeResult } from './compute';
import type { PileWorkerRequest, PileWorkerResponse } from './workerProtocol';

let nextId = 1;

/**
 * Worker で計算する。onProgress には計算の段階と進み具合（0〜1）が届く。
 * Worker は計算ごとに起動し、終わったら止める。
 */
export function computePileInWorker(
  grid: string,
  params: PileComputeParams,
  onProgress?: (p: PileComputeProgress) => void,
): Promise<PileComputeResult> {
  const worker = new Worker(new URL('./pile.worker.ts', import.meta.url), { type: 'module', name: 'pile-scene' });
  const id = nextId++;
  return new Promise<PileComputeResult>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<PileWorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') onProgress?.(msg.progress);
      else {
        worker.terminate();
        if (msg.type === 'done') resolve(msg.result);
        else reject(new Error(msg.message));
      }
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(`山の計算の Worker でエラーが起きました: ${ev.message}`));
    };
    const req: PileWorkerRequest = { id, grid, publicRoot: assetUrl(''), params };
    worker.postMessage(req);
  });
}
