/**
 * スクロール位置に応じてカメラを動かす。語りの最中は OrbitControls を無効にし、canvas はポインタを受けない
 * （タッチ・ホイールのスクロールを妨げない）。`setFreeOrbit(true)` を呼ぶと OrbitControls を有効にして自由に動かせる。
 *
 * 自由操作の間も、1本指の縦スワイプはページのスクロールになる（canvas の `touch-action: pan-y`）。
 * 1本指の横ドラッグで回転、2本指でズームと傾き、マウスはドラッグで回転・ホイールでズーム。
 */
import { TOUCH, type PerspectiveCamera } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  applyFit,
  clipPlanesFor,
  DEFAULT_HOLD,
  keyframeToPose,
  lerpPose,
  liftAboveGround,
  MAX_ELEVATION_DEG,
  poseDelta,
  poseFromCamera,
  poseToCameraPosition,
  samplePathLifted,
  stopViewFor,
  viewFor,
  type StagePoses,
  type CameraPose,
  type FitFrame,
  type GroundHeightAt,
  type GroundYAt,
} from './cameraPath';
import { prefersReducedMotion } from './motion';
import type { StoryCameraKeyframe, StoryCameraView, StoryStage } from './types';

export interface CameraRigTarget {
  camera: PerspectiveCamera;
  controls: OrbitControls;
  /** OrbitControls を無効にしている間、ポインタ操作を背後のページ（スクロール）へ通すために使う。 */
  renderer: { domElement: HTMLElement };
}

export interface CameraRigOptions {
  /** 追従の速さ（1/秒）。大きいほど素早く目標に追いつく。既定 6。 */
  stiffness?: number;
  /** 各キーフレームで止まる割合。配列なら段階ごと。既定 `DEFAULT_HOLD`（`createStory` は本文カードの位置から求める）。 */
  hold?: number | readonly number[];
  /** 動きを減らす設定か。既定は `prefers-reduced-motion`。 */
  reducedMotion?: () => boolean;
  /** キーフレームの注視点の地表のローカル Y。既定は `latLonToLocal` で高さ 0 として求めた Y。 */
  groundY?: GroundYAt;
  /** カメラの真下の地表のローカル Y（ローカル座標の x, z から）。カメラはこれより `minClearance` 以上高く保つ。既定は常に 0。 */
  groundHeightAt?: GroundHeightAt;
  /** カメラの地表からの高さの下限(m)。既定 1。 */
  minClearance?: number;
  /**
   * 場面の間を移る途中のカメラの地表からの高さの下限の上限(m)（`transitionFloor`）。移る途中は、両端のカメラの高さの大きい方
   * （この値まで）より下がらない。既定 0（持ち上げない）。
   */
  transitionClearance?: number;
  /** near / far を毎フレーム、注視点までの距離と地表からの高さに合わせて設定するか。既定 true。 */
  autoClip?: boolean;
}

export interface CameraRig {
  /** スクロールの連続位置（`StoryState.position`）。immediate なら補間せずその場へ移る。 */
  setPosition(position: number, immediate?: boolean): void;
  /** 段階ごとの止まる割合を差し替える。 */
  setHolds(hold: number | readonly number[]): void;
  /** 自由操作を始める（true）・やめる（false）。やめると、その場から語りのカメラ位置へ戻る。 */
  setFreeOrbit(on: boolean): void;
  /**
   * 毎フレーム呼ぶ。dtSec は前フレームからの秒数。
   * 戻り値はカメラが動いた（描画が必要）か。カメラが目標に収束していて操作もなければ false。
   */
  update(dtSec: number): boolean;
  /**
   * 注視点の画面上の位置を、画面の中心からずらす（カメラの向きは変えず、投影の中心だけをずらす）。
   * x, y は画面の幅・高さに対する割合で、x が正なら右へ、y が正なら下へずれる（`layout.ts` の `viewShiftFor`）。
   * 割合なので、画面の大きさが変わっても保たれる。自由操作の間も保たれる。
   */
  setViewShift(shift: { x: number; y: number }): void;
  /** いまのずらし量。 */
  readonly viewShift: { x: number; y: number };
  /**
   * 画面の大きさと、本文カードに覆われていない範囲の大きさ(CSS px)を伝える。キーフレームの `fit`（収めたい地表の範囲）が
   * あるとき、この範囲が覆われていない範囲に収まる距離を求め直す。null か未設定の間は `fit` を使わず、`distance` のまま。
   * 縦の画角はカメラの `fov` を使う。portrait は本文カードが下寄せの配置か（縦長の画面用のカメラ `portrait` を使う。省略時は前の値）。
   */
  setFitFrame(frame: { canvasHeight: number; regionWidth: number; regionHeight: number; portrait?: boolean } | null): void;
  /**
   * 段階 index のキーフレームを差し替える（null で台本の値に戻す）。カメラ位置の候補を試す確認用。
   * 差し替えた後のカメラは、その段階にいればそこへ滑らかに移る。
   */
  setStageCamera(index: number, keyframe: StoryCameraKeyframe | null): void;
  /**
   * 連続位置 position での語りのカメラ姿勢（追従の遅れを含まない、スクロールが止まったときの姿勢。地面より上に持ち上げた後）。
   * 場面の間の移動の経路を調べるのに使う。
   */
  poseAt(position: number): CameraPose;
  /** 縦長の画面用のカメラ（`StoryCameraKeyframe.portrait`。本文カードが下寄せの配置のとき）を使っているか。 */
  readonly portrait: boolean;
  /** OrbitControls を有効にしている最中か。 */
  readonly isFree: boolean;
  /** 現在のカメラ姿勢。 */
  getPose(): CameraPose;
  /** canvas の pointer-events / touch-action と OrbitControls の設定を元に戻す。 */
  dispose(): void;
}

const CONVERGED = 1e-3;
/** 経路上の連続位置が、スクロールの位置にこれより近づいたら追いついたとみなす（段階の 1 万分の 1）。 */
const FOLLOW_CONVERGED = 1e-4;
/** これより小さな変化は「動いていない」とみなす（描画を省く判定）。 */
const UNCHANGED = 1e-7;
const DEG2RAD = Math.PI / 180;

export function createCameraRig(
  target: CameraRigTarget,
  stages: readonly StoryStage[],
  options: CameraRigOptions = {},
): CameraRig {
  const { camera, controls } = target;
  const canvas = target.renderer.domElement;
  const stiffness = options.stiffness ?? 6;
  let hold: number | readonly number[] = options.hold ?? DEFAULT_HOLD;
  const reduced = options.reducedMotion ?? prefersReducedMotion;
  const groundAt: GroundHeightAt = options.groundHeightAt ?? (() => 0);
  const minClearance = options.minClearance ?? 1;
  const autoClip = options.autoClip ?? true;
  const transitionClearance = options.transitionClearance ?? 0;
  if (stages.length === 0) throw new Error('stages が空です');
  const overrides: (StoryCameraKeyframe | null)[] = stages.map(() => null);
  /**
   * 本文カードが下寄せの配置（縦長の画面用のカメラ `portrait` を使う）か。`setFitFrame` で配置が伝わるまでは、
   * カメラの aspect（縦長か）で決める。
   */
  let portrait = camera.aspect < 1;
  let fitFrame: FitFrame | null = null;
  const toPose = (view: StoryCameraView): CameraPose => applyFit(keyframeToPose(view, options.groundY), view.fit, fitFrame);
  const fitPoses = (): StagePoses[] =>
    stages.map((s, i) => {
      const k = overrides[i] ?? s.camera;
      return {
        start: toPose(viewFor(k, portrait)),
        stops: (k.stops ?? []).map((stop) => ({ at: stop.at, pose: toPose(stopViewFor(stop, portrait)) })),
      };
    });
  let poses = fitPoses();

  // dispose で戻すため、触る設定の元の値を覚えておく。
  const original = {
    pointerEvents: canvas.style.pointerEvents,
    touchAction: canvas.style.touchAction,
    enabled: controls.enabled,
    enableZoom: controls.enableZoom,
    minPolarAngle: controls.minPolarAngle,
    touches: { ...controls.touches },
    target: controls.target.clone(),
    near: camera.near,
    far: camera.far,
  };

  let position = 0;
  /**
   * カメラがたどっている経路上の連続位置。スクロールの位置（position）を時間で追いかける。カメラはつねに経路
   * （場面の間を移る途中は持ち上げた経路）の上にあり、速くスクロールしても経路の外を近道しない。
   */
  let follow = 0;
  /** 自由操作から戻る途中・経路が変わった直後は、いまの姿勢から経路へ滑らかに寄せる。 */
  let rejoin = false;
  let shift = { x: 0, y: 0 };
  let current: CameraPose = (poses[0] as StagePoses).start;
  let free = false;
  let disposed = false;
  /** 最後にカメラへ当てた姿勢。変化がなければ描画を省ける。 */
  let applied: CameraPose | null = null;
  /** 自由操作の入力（OrbitControls の change/start/end）があったか。 */
  let inputDirty = false;
  let dirty = true;

  const onControlsEvent = (): void => {
    inputDirty = true;
  };
  controls.addEventListener('change', onControlsEvent);
  controls.addEventListener('start', onControlsEvent);
  controls.addEventListener('end', onControlsEvent);

  /** 連続位置 at の語りのカメラ（場面の間を移る途中は持ち上げた経路）。 */
  function pathPose(at: number): CameraPose {
    if (reduced()) {
      // 即時の切り替え: 段階の番号のキーフレーム（場面の始まり）に固定する。
      return (poses[Math.min(Math.floor(at), poses.length - 1)] as StagePoses).start;
    }
    return samplePathLifted(poses, at, { hold, groundAt, cap: transitionClearance });
  }

  function updateClip(distance: number, cameraY: number, x: number, z: number): boolean {
    if (!autoClip) return false;
    const { near, far } = clipPlanesFor(distance, cameraY - groundAt(x, z));
    if (Math.abs(near - camera.near) <= camera.near * 1e-3 && Math.abs(far - camera.far) <= camera.far * 1e-3) return false;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
    return true;
  }

  /** 姿勢をカメラへ当てる。戻り値は前回から変わったか。 */
  function apply(pose: CameraPose): boolean {
    const lifted = liftAboveGround(pose, groundAt, minClearance);
    const changed = !applied || poseDelta(lifted, applied) > UNCHANGED;
    applied = lifted;
    const p = poseToCameraPosition(lifted);
    controls.target.set(lifted.target.x, lifted.target.y, lifted.target.z);
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(lifted.target.x, lifted.target.y, lifted.target.z);
    const clipChanged = updateClip(lifted.distance, p.y, p.x, p.z);
    return changed || clipChanged;
  }

  function setFree(on: boolean): void {
    if (on === free || disposed) return;
    free = on;
    dirty = true;
    controls.enabled = on;
    // 語りの間は canvas がポインタを受けないようにして、タッチ/ホイールのスクロールを妨げない。
    canvas.style.pointerEvents = on ? 'auto' : 'none';
    // OrbitControls は touch-action: none にするが、1本指の縦スワイプは常にスクロールにする。
    canvas.style.touchAction = 'pan-y';
    controls.enableZoom = on;
    if (on) {
      controls.target.set(current.target.x, current.target.y, current.target.z);
      controls.update();
    } else {
      // 自由に動かした位置から、語りのカメラ位置へ滑らかに戻る。
      current = poseFromCamera(camera.position, controls.target);
      rejoin = true;
    }
  }

  /** 投影の中心のずらしをカメラへ当てる。画面の大きさに依らないよう、全体を 1×1 の単位で表す。 */
  function applyShift(): void {
    if (Math.abs(shift.x) < 1e-5 && Math.abs(shift.y) < 1e-5) {
      if (camera.view?.enabled) camera.clearViewOffset();
    } else {
      // setViewOffset は aspect を fullWidth / fullHeight（ここでは 1）に書き換えるので、画面の縦横比を戻す。
      const aspect = camera.aspect;
      camera.setViewOffset(1, 1, -shift.x, -shift.y, 1, 1);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
  }

  controls.enabled = false;
  controls.enableZoom = false;
  // 真上（仰角 90°）を避ける。極角 = 90° - 仰角。
  controls.minPolarAngle = Math.max(controls.minPolarAngle, (90 - MAX_ELEVATION_DEG) * DEG2RAD);
  controls.touches.ONE = TOUCH.ROTATE;
  controls.touches.TWO = TOUCH.DOLLY_ROTATE;
  canvas.style.pointerEvents = 'none';
  canvas.style.touchAction = 'pan-y';
  apply(current);

  return {
    setPosition(next, immediate = false) {
      if (next !== position) dirty = true;
      position = next;
      if (immediate && !free) {
        follow = position;
        rejoin = false;
        current = pathPose(follow);
        apply(current);
      }
    },
    setHolds(next) {
      hold = next;
      rejoin = true;
      dirty = true;
    },
    setFreeOrbit(on) {
      setFree(on);
    },
    setViewShift(next) {
      if (disposed || (next.x === shift.x && next.y === shift.y)) return;
      shift = { x: next.x, y: next.y };
      applyShift();
      dirty = true;
    },
    get viewShift() {
      return shift;
    },
    setFitFrame(next) {
      if (disposed) return;
      const frame = next
        ? { fovDeg: camera.fov, canvasHeight: next.canvasHeight, regionWidth: next.regionWidth, regionHeight: next.regionHeight }
        : null;
      const same =
        frame === null
          ? fitFrame === null
          : fitFrame !== null &&
            frame.fovDeg === fitFrame.fovDeg &&
            frame.canvasHeight === fitFrame.canvasHeight &&
            frame.regionWidth === fitFrame.regionWidth &&
            frame.regionHeight === fitFrame.regionHeight;
      const nextPortrait = next?.portrait ?? portrait;
      if (same && nextPortrait === portrait) return;
      fitFrame = frame;
      portrait = nextPortrait;
      poses = fitPoses();
      rejoin = true;
      dirty = true;
    },
    setStageCamera(index, keyframe) {
      if (disposed || index < 0 || index >= stages.length) return;
      overrides[index] = keyframe;
      poses = fitPoses();
      rejoin = true;
      dirty = true;
    },
    poseAt(at) {
      return liftAboveGround(pathPose(at), groundAt, minClearance);
    },
    get portrait() {
      return portrait;
    },
    update(dtSec) {
      if (disposed) return false;
      if (free) {
        const moved = inputDirty || dirty;
        inputDirty = false;
        dirty = false;
        const t = controls.target;
        const clip = updateClip(camera.position.distanceTo(t), camera.position.y, camera.position.x, camera.position.z);
        return moved || clip;
      }
      const wasDirty = dirty;
      dirty = false;
      if (reduced()) {
        follow = position;
        rejoin = false;
        current = pathPose(follow);
      } else {
        const k = 1 - Math.exp(-stiffness * Math.max(dtSec, 0));
        follow += (position - follow) * k;
        if (Math.abs(position - follow) < FOLLOW_CONVERGED) follow = position;
        const onPath = pathPose(follow);
        if (rejoin) {
          current = lerpPose(current, onPath, k);
          if (poseDelta(current, onPath) < CONVERGED) {
            current = onPath;
            rejoin = false;
          }
        } else {
          current = onPath;
        }
      }
      return apply(current) || wasDirty;
    },
    get isFree() {
      return free;
    },
    getPose: () => (free ? poseFromCamera(camera.position, controls.target) : current),
    dispose() {
      if (disposed) return;
      disposed = true;
      controls.removeEventListener('change', onControlsEvent);
      controls.removeEventListener('start', onControlsEvent);
      controls.removeEventListener('end', onControlsEvent);
      canvas.style.pointerEvents = original.pointerEvents;
      canvas.style.touchAction = original.touchAction;
      controls.enabled = original.enabled;
      controls.enableZoom = original.enableZoom;
      controls.minPolarAngle = original.minPolarAngle;
      Object.assign(controls.touches, original.touches);
      controls.target.copy(original.target);
      if (camera.view?.enabled) camera.clearViewOffset();
      if (autoClip) {
        camera.near = original.near;
        camera.far = original.far;
        camera.updateProjectionMatrix();
      }
    },
  };
}
