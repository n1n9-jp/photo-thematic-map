/**
 * 秋葉原の配置を Web Worker で計算する（路上の判定に約0.1〜0.2秒かかるので、主スレッドを止めない）。
 * 結果の TypedArray は転送（コピーなし）で受け取る。
 */
import { assetUrl } from '../../../paths';
import { AKIHABARA_COUNT, type AkihabaraLayoutResult } from './layout';
import type { AkihabaraWorkerRequest, AkihabaraWorkerResponse } from './workerProtocol';

let nextId = 1;

/** Worker で計算する。格子の読み込みの時間(ms)も返す。Worker は計算ごとに起動し、終わったら止める。 */
export function computeAkihabaraInWorker(count = AKIHABARA_COUNT): Promise<AkihabaraLayoutResult & { loadMs: number }> {
  const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'akihabara-layout' });
  const id = nextId++;
  return new Promise((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<AkihabaraWorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      worker.terminate();
      if (msg.type === 'done') resolve({ ...msg.result, loadMs: msg.loadMs });
      else reject(new Error(msg.message));
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(`秋葉原の配置の Worker でエラーが起きました: ${ev.message}`));
    };
    const req: AkihabaraWorkerRequest = { id, publicRoot: assetUrl(''), count };
    worker.postMessage(req);
  });
}
