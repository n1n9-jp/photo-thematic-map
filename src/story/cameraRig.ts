/**
 * スクロール位置に応じてカメラを動かす。語りの最中は OrbitControls を無効にし、
 * `freeOrbit` の段階に入ったら有効にして自由に動かせるようにする。
 */
import type { PerspectiveCamera } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  DEFAULT_HOLD,
  keyframeToPose,
  lerpPose,
  poseDelta,
  poseFromCamera,
  poseToCameraPosition,
  samplePath,
  type CameraPose,
} from './cameraPath';
import { prefersReducedMotion } from './motion';
import type { StoryStage } from './types';

export interface CameraRigTarget {
  camera: PerspectiveCamera;
  controls: OrbitControls;
  /** OrbitControls を無効にしている間、ポインタ操作を背後のページ（スクロール）へ通すために使う。 */
  renderer: { domElement: HTMLElement };
}

export interface CameraRigOptions {
  /** 追従の速さ（1/秒）。大きいほど素早く目標に追いつく。既定 6。 */
  stiffness?: number;
  /** 各キーフレームで止まる割合。既定 `DEFAULT_HOLD`。 */
  hold?: number;
  /** 動きを減らす設定か。既定は `prefers-reduced-motion`。 */
  reducedMotion?: () => boolean;
}

export interface CameraRig {
  /** スクロールの連続位置（`StoryState.position`）。immediate なら補間せずその場へ移る。 */
  setPosition(position: number, immediate?: boolean): void;
  /** 自由に動かせる状態にしたいか。カメラが目標に追いついてから実際に切り替わる。 */
  setFreeOrbit(requested: boolean): void;
  /** 毎フレーム呼ぶ。dtSec は前フレームからの秒数。 */
  update(dtSec: number): void;
  /** OrbitControls を有効にしている最中か。 */
  readonly isFree: boolean;
  /** 現在のカメラ姿勢。 */
  getPose(): CameraPose;
}

const CONVERGED = 1e-3;

export function createCameraRig(
  target: CameraRigTarget,
  stages: readonly StoryStage[],
  options: CameraRigOptions = {},
): CameraRig {
  const { camera, controls } = target;
  const canvas = target.renderer.domElement;
  const stiffness = options.stiffness ?? 6;
  const hold = options.hold ?? DEFAULT_HOLD;
  const reduced = options.reducedMotion ?? prefersReducedMotion;
  const poses = stages.map((s) => keyframeToPose(s.camera));
  if (poses.length === 0) throw new Error('stages が空です');

  let position = 0;
  let current: CameraPose = poses[0] as CameraPose;
  let freeRequested = false;
  let free = false;

  function desiredPose(): CameraPose {
    if (reduced()) {
      // 即時の切り替え: 段階の番号のキーフレームに固定する。
      return poses[Math.min(Math.floor(position), poses.length - 1)] as CameraPose;
    }
    return samplePath(poses, position, { hold });
  }

  function apply(pose: CameraPose): void {
    const p = poseToCameraPosition(pose);
    controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
  }

  function setFree(on: boolean): void {
    if (on === free) return;
    free = on;
    controls.enabled = on;
    // 無効の間は canvas がポインタを受けないようにして、タッチ/ホイールのスクロールを妨げない。
    canvas.style.pointerEvents = on ? 'auto' : 'none';
    // ホイールをズームに使うと、キャンバス上でページがスクロールできなくなるため止める。
    controls.enableZoom = false;
    if (!on) current = poseFromCamera(camera.position, controls.target);
  }

  controls.enabled = false;
  controls.enableZoom = false;
  canvas.style.pointerEvents = 'none';
  apply(current);

  return {
    setPosition(next, immediate = false) {
      position = next;
      if (immediate && !free) {
        current = desiredPose();
        apply(current);
      }
    },
    setFreeOrbit(requested) {
      freeRequested = requested;
      if (!requested) setFree(false);
    },
    update(dtSec) {
      if (free) return;
      const desired = desiredPose();
      let settled = true;
      if (reduced()) {
        current = desired;
      } else {
        const k = 1 - Math.exp(-stiffness * Math.max(dtSec, 0));
        current = lerpPose(current, desired, k);
        if (poseDelta(current, desired) < CONVERGED) current = desired;
        else settled = false;
      }
      apply(current);
      if (freeRequested && settled) setFree(true);
    },
    get isFree() {
      return free;
    },
    getPose: () => (free ? poseFromCamera(camera.position, controls.target) : current),
  };
}
