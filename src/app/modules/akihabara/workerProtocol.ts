/** 秋葉原の配置の Worker とのやりとり。 */
import type { AkihabaraLayoutResult } from './layout';

export interface AkihabaraWorkerRequest {
  id: number;
  /** 公開ルートの絶対 URL（`assetUrl('')`）。 */
  publicRoot: string;
  count: number;
}

export type AkihabaraWorkerResponse =
  | { id: number; type: 'done'; result: AkihabaraLayoutResult; loadMs: number }
  | { id: number; type: 'error'; message: string };
