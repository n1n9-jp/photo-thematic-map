/**
 * 駅の周りの配置（`layoutStation` の結果）を `BicycleInstances` に変換する。
 */
import { Quaternion, Vector3 } from 'three';
import type { StationLayout } from '../../sim/stationLayout';
import type { BicycleInstances } from './field';
import { pickFrameColor } from './geometry';
import { allocateInstances, createRng } from './layouts';

export interface StationInstancesOptions {
  /** フレーム色を選ぶ乱数の種（既定 1）。同じ種なら同じ色になる。 */
  seed?: number;
  /** 先頭から何台を変換するか（既定 全台）。置いた順なので「k 台のときの配置」になる。 */
  count?: number;
}

const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

/** 配置を描画用のインスタンスに変換する。色は置いた順に決まるので、count を変えても同じ自転車は同じ色。 */
export function stationLayoutToInstances(layout: StationLayout, options: StationInstancesOptions = {}): BicycleInstances {
  const n = Math.max(0, Math.min(layout.count, Math.floor(options.count ?? layout.count)));
  const rng = createRng(options.seed ?? 1);
  const out = allocateInstances(n);
  const q = new Quaternion();
  const qr = new Quaternion();
  for (let i = 0; i < n; i++) {
    out.positions[i * 3] = layout.positions[i * 3]!;
    out.positions[i * 3 + 1] = layout.positions[i * 3 + 1]!;
    out.positions[i * 3 + 2] = layout.positions[i * 3 + 2]!;
    q.setFromAxisAngle(Y_AXIS, layout.yaws[i]!).multiply(qr.setFromAxisAngle(X_AXIS, layout.rolls[i]!));
    out.quaternions[i * 4] = q.x;
    out.quaternions[i * 4 + 1] = q.y;
    out.quaternions[i * 4 + 2] = q.z;
    out.quaternions[i * 4 + 3] = q.w;
    const hex = pickFrameColor(rng());
    out.colors[i * 3] = (hex >> 16) & 255;
    out.colors[i * 3 + 1] = (hex >> 8) & 255;
    out.colors[i * 3 + 2] = hex & 255;
    out.shades![i] = Math.round((0.94 + rng() * 0.06) * 255);
  }
  return out;
}
