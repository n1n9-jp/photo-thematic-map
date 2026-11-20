/** 山の計算の Worker とのやりとり。 */
import type { PileComputeParams, PileComputeProgress, PileComputeResult } from './compute';

export interface PileWorkerRequest {
  id: number;
  /** 格子の名前（`public/data/grids/<名前>.json`）。 */
  grid: string;
  /** 公開ルートの絶対 URL（`assetUrl('')`）。 */
  publicRoot: string;
  params: PileComputeParams;
}

export type PileWorkerResponse =
  | { id: number; type: 'progress'; progress: PileComputeProgress }
  | { id: number; type: 'done'; result: PileComputeResult }
  | { id: number; type: 'error'; message: string };
