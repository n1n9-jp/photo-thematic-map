/**
 * 縦長の画面用のカメラ（`StoryCameraKeyframe.portrait`）、キーフレームの差し替え、場面の間を移る途中の持ち上げ。
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { describe, expect, it } from 'vitest';
import {
  keyframeToPose,
  poseToCameraPosition,
  samplePath,
  distanceToFit,
  samplePathLifted,
  segmentAt,
  transitionFloor,
  TRANSITION_RAMP,
  viewFor,
  viewsOf,
  type CameraPose,
} from '../../src/story/cameraPath';
import { createCameraRig } from '../../src/story/cameraRig';
import type { StoryCameraKeyframe, StoryStage } from '../../src/story/types';

const landscape: StoryCameraKeyframe = {
  target: { lat: 35.68, lon: 139.76, alt: 0 },
  distance: 400,
  azimuthDeg: 0,
  elevationDeg: 70,
};
const withPortrait: StoryCameraKeyframe = {
  ...landscape,
  portrait: { target: { lat: 35.681, lon: 139.76, alt: 0 }, distance: 900, azimuthDeg: 90, elevationDeg: 75 },
};

describe('viewFor / viewsOf', () => {
  it('縦長で portrait があればそれ、なければ横長の値', () => {
    expect(viewFor(withPortrait, false)).toBe(withPortrait);
    expect(viewFor(withPortrait, true)).toBe(withPortrait.portrait);
    expect(viewFor(landscape, true)).toBe(landscape);
    expect(viewsOf(withPortrait)).toHaveLength(2);
    expect(viewsOf(landscape)).toHaveLength(1);
  });
});

function makeRig(stages: StoryStage[], aspect: number, options: { transitionClearance?: number; reducedMotion?: () => boolean } = {}) {
  const camera = new PerspectiveCamera(45, aspect, 1, 100_000);
  const controls = {
    addEventListener() {},
    removeEventListener() {},
    update() {},
    target: new Vector3(),
    enabled: true,
    enableZoom: true,
    minPolarAngle: 0,
    touches: {},
  } as unknown as OrbitControls;
  const style: Record<string, string> = {};
  const rig = createCameraRig({ camera, controls, renderer: { domElement: { style } as unknown as HTMLElement } }, stages, {
    reducedMotion: () => true,
    ...options,
  });
  return { rig, camera, controls };
}

const stage = (id: string, camera: StoryCameraKeyframe): StoryStage => ({ id, text: { heading: id, paragraphs: [] }, camera });

describe('カメラリグ: 縦長の画面用のカメラ', () => {
  it('本文カードが下寄せの配置なら portrait を使い、左の列の配置に戻すと横長の値になる（縦長の画面でも左の列なら横長の値）', () => {
    const { rig, camera, controls } = makeRig([stage('a', withPortrait)], 1280 / 720);
    rig.update(1);
    expect(rig.portrait).toBe(false);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(400, 3);

    rig.setFitFrame({ portrait: true, canvasHeight: 844, regionWidth: 390, regionHeight: 500 });
    rig.update(1);
    expect(rig.portrait).toBe(true);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(900, 3);
    expect(rig.getPose().azimuthDeg).toBeCloseTo(90, 6);

    rig.setFitFrame({ portrait: false, canvasHeight: 720, regionWidth: 842, regionHeight: 720 });
    rig.update(1);
    expect(rig.portrait).toBe(false);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(400, 3);

    // タブレットの縦向き（768×1024）: 縦長の画面だが、本文カードは左の列
    camera.aspect = 768 / 1024;
    rig.setFitFrame({ portrait: false, canvasHeight: 1024, regionWidth: 330, regionHeight: 1024 });
    rig.update(1);
    expect(rig.portrait).toBe(false);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(400, 3);
  });

  it('setStageCamera でキーフレームを差し替え、null で台本の値に戻る', () => {
    const { rig, camera, controls } = makeRig([stage('a', landscape)], 1280 / 720);
    rig.setStageCamera(0, { ...landscape, distance: 250 });
    rig.update(1);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(250, 3);
    rig.setStageCamera(0, null);
    rig.update(1);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(400, 3);
  });
});

describe('場面の間を移る途中の持ち上げ', () => {
  const ground = (): number => 0;
  // 地上の目線（高さ約 1.8m）から、別の場所の地上の目線へ
  const a: CameraPose = { target: { x: 0, y: 1.5, z: 0 }, distance: 7, azimuthDeg: 0, elevationDeg: 3 };
  const b: CameraPose = { target: { x: 300, y: 1.5, z: 0 }, distance: 7, azimuthDeg: 90, elevationDeg: 3 };
  const high: CameraPose = { target: { x: 300, y: 0, z: 0 }, distance: 300, azimuthDeg: 0, elevationDeg: 75 };

  it('segmentAt は samplePath と同じ区間と進み具合', () => {
    expect(segmentAt(3, 0.2, 0.4)).toEqual({ i: 0, t: 0 });
    expect(segmentAt(3, 0.7, 0.4).i).toBe(0);
    expect(segmentAt(3, 0.7, 0.4).t).toBeCloseTo(0.5, 9);
    expect(segmentAt(3, 2, 0.4)).toEqual({ i: 1, t: 1 });
  });

  it('transitionFloor は両端で 0、途中は両端の高さの大きい方（上限まで）', () => {
    expect(transitionFloor(2, 260, 0, 200)).toBe(0);
    expect(transitionFloor(2, 260, 1, 200)).toBe(0);
    expect(transitionFloor(2, 260, 0.5, 200)).toBe(200);
    expect(transitionFloor(2, 120, 0.5, 200)).toBe(120);
    expect(transitionFloor(2, 120, TRANSITION_RAMP, 200)).toBe(120);
    expect(transitionFloor(2, 120, TRANSITION_RAMP / 2, 200)).toBeGreaterThan(0);
    expect(transitionFloor(2, 120, TRANSITION_RAMP / 2, 200)).toBeLessThan(120);
  });

  it('キーフレームの位置と止まっている間は変えず、移る途中は持ち上げる', () => {
    const poses = [a, high, b];
    const opts = { hold: 0.4, groundAt: ground, cap: 200 };
    for (const pos of [0, 0.2, 0.4, 1, 1.3, 2]) {
      expect(samplePathLifted(poses, pos, opts)).toEqual(samplePath(poses, pos, opts));
    }
    // 地上から上空へ移る途中: 高さは上空のカメラの高さ（約 290m）の上限 200m まで上がる
    const mid = poseToCameraPosition(samplePathLifted(poses, 0.7, opts));
    expect(mid.y).toBeGreaterThanOrEqual(200 - 1e-6);
    // cap 0 なら持ち上げない
    expect(samplePathLifted(poses, 0.7, { ...opts, cap: 0 })).toEqual(samplePath(poses, 0.7, opts));
  });

  it('カメラリグの poseAt は持ち上げた姿勢を返す', () => {
    const near = { ...landscape, distance: 7, elevationDeg: 10 };
    const far = { ...landscape, target: { lat: 35.683, lon: 139.76, alt: 0 }, distance: 300, elevationDeg: 75 };
    const { rig } = makeRig([stage('a', near), stage('b', far)], 1.5, { transitionClearance: 200, reducedMotion: () => false });
    const p = poseToCameraPosition(rig.poseAt(0.7));
    const lowest = poseToCameraPosition(keyframeToPose(near)).y;
    expect(p.y - lowest).toBeGreaterThan(100);
  });
});

describe('場面の中の経由点', () => {
  const near: StoryCameraKeyframe = { target: { lat: 35.68, lon: 139.76, alt: 0 }, distance: 80, azimuthDeg: 300, elevationDeg: 60 };
  const far: StoryCameraKeyframe = { target: { lat: 35.681, lon: 139.761, alt: 0 }, distance: 500, azimuthDeg: 30, elevationDeg: 80 };
  const next: StoryCameraKeyframe = { target: { lat: 35.69, lon: 139.77, alt: 0 }, distance: 2000, azimuthDeg: 0, elevationDeg: 60 };
  const withStops: StoryCameraKeyframe = { ...near, stops: [{ at: 0.1, camera: near }, { at: 0.5, camera: far, portrait: { ...far, distance: 900 } }] };

  it('止まっている区間の割合に応じて経由点をたどり、最後の経由点から次の段階へ移る', () => {
    const p = (k: StoryCameraKeyframe) => keyframeToPose(k);
    const stages = [{ start: p(near), stops: [{ at: 0.1, pose: p(near) }, { at: 0.5, pose: p(far) }] }, { start: p(next), stops: [] }];
    const hold = 0.4;
    expect(samplePath(stages, 0, { hold }).distance).toBeCloseTo(80, 6);
    expect(samplePath(stages, 0.04, { hold }).distance).toBeCloseTo(80, 6); // 0.1 × 0.4
    const mid = samplePath(stages, 0.12, { hold }).distance; // 0.3 × 0.4
    expect(mid).toBeGreaterThan(80);
    expect(mid).toBeLessThan(500);
    expect(samplePath(stages, 0.2, { hold }).distance).toBeCloseTo(500, 6); // 0.5 × 0.4
    expect(samplePath(stages, 0.39, { hold }).distance).toBeCloseTo(500, 6);
    // 次の段階へは、場面の終わり（far）から移る
    expect(samplePath(stages, 0.4001, { hold }).azimuthDeg).toBeCloseTo(30, 1);
    expect(samplePath(stages, 1, { hold }).distance).toBeCloseTo(2000, 6);
  });

  it('カメラリグは経由点にも縦長の画面用のカメラを使う', () => {
    const { rig, camera, controls } = makeRig([stage('a', withStops), stage('b', next)], 0.5, { reducedMotion: () => false });
    rig.setHolds([0.4, 0.4]);
    rig.setFitFrame({ portrait: true, canvasHeight: 844, regionWidth: 390, regionHeight: 500 });
    rig.setPosition(0.3, true); // 止まっている区間 0.4 の 0.75 → 最後の経由点
    rig.update(1);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(900, 3);
    expect(viewsOf(withStops)).toHaveLength(4);
  });
});

describe('fit の点', () => {
  it('points があれば、点がすべて覆われていない範囲に収まる距離になる（遠い点ほど遠く）', () => {
    const frame = { fovDeg: 45, canvasHeight: 720, regionWidth: 842, regionHeight: 720 };
    const angles = { azimuthDeg: 30, elevationDeg: 75 };
    const small = distanceToFit({ eastWestM: 0, northSouthM: 0, points: [{ eastM: 50, northM: 0 }, { eastM: -50, northM: 20 }] }, angles, frame);
    const large = distanceToFit({ eastWestM: 0, northSouthM: 0, points: [{ eastM: 150, northM: 0 }, { eastM: -150, northM: 90 }] }, angles, frame);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small * 2);
    // 高さのある点（山の頂上・建物の上端）も入る
    const tall = distanceToFit({ eastWestM: 0, northSouthM: 0, points: [{ eastM: 0, northM: 0, upM: 300 }] }, { azimuthDeg: 0, elevationDeg: 20 }, frame);
    expect(tall).toBeGreaterThan(0);
  });
});

describe('カメラリグ: 経路に沿って追いかける', () => {
  it('一気にスクロールしても、毎フレームのカメラは持ち上げた経路（poseAt）の上にある', () => {
    const ground: StoryCameraKeyframe = { target: { lat: 35.68, lon: 139.76, alt: 1 }, distance: 6, azimuthDeg: 270, elevationDeg: 10 };
    const above: StoryCameraKeyframe = { target: { lat: 35.682, lon: 139.762, alt: 0 }, distance: 400, azimuthDeg: 30, elevationDeg: 75 };
    const { rig, camera } = makeRig([stage('a', ground), stage('b', above)], 1.5, { transitionClearance: 200, reducedMotion: () => false });
    rig.setHolds([0.4, 0.4]);
    rig.setPosition(0.2, true);
    rig.update(0.016);
    rig.setPosition(1.2);
    let onPath = 0;
    for (let n = 0; n < 200; n++) {
      rig.update(1 / 30);
      // いまの姿勢は、経路上のどこかの位置の姿勢と一致する
      const pose = rig.getPose();
      const cam = poseToCameraPosition(pose);
      let best = Infinity;
      for (let k = 0; k <= 1000; k++) {
        const q = poseToCameraPosition(rig.poseAt(0.2 + k / 1000));
        best = Math.min(best, Math.hypot(q.x - cam.x, q.y - cam.y, q.z - cam.z));
      }
      expect(best).toBeLessThan(Math.max(1, pose.distance * 0.01));
      onPath++;
    }
    expect(onPath).toBe(200);
    expect(camera.position.distanceTo(new Vector3(...Object.values(poseToCameraPosition(rig.poseAt(1.2))) as [number, number, number]))).toBeLessThan(1);
  });
});

describe('カメラリグ: 「動きを減らす」設定と場面の中の経由点', () => {
  const near: StoryCameraKeyframe = { target: { lat: 35.68, lon: 139.76, alt: 0 }, distance: 20, azimuthDeg: 225, elevationDeg: 45 };
  const mid: StoryCameraKeyframe = { target: { lat: 35.6805, lon: 139.7605, alt: 0 }, distance: 150, azimuthDeg: 300, elevationDeg: 70 };
  const far: StoryCameraKeyframe = { target: { lat: 35.681, lon: 139.761, alt: 0 }, distance: 325, azimuthDeg: 0, elevationDeg: 80 };
  const next: StoryCameraKeyframe = { target: { lat: 35.69, lon: 139.77, alt: 0 }, distance: 2000, azimuthDeg: 0, elevationDeg: 60 };
  const withStops: StoryCameraKeyframe = { ...near, stops: [{ at: 0.05, camera: near }, { at: 0.5, camera: mid }, { at: 1, camera: far }] };

  it('場面の中では補間せず、進みに応じて「そこまでが収まる」経由点へ切り替わり、場面の終わりでは最後の経由点になる', () => {
    const { rig, camera, controls } = makeRig([stage('a', withStops), stage('b', next)], 1.5, { reducedMotion: () => true });
    rig.setHolds([0.4, 0.4]);
    const distanceAt = (position: number): number => {
      rig.setPosition(position);
      rig.update(1 / 60);
      return camera.position.distanceTo(controls.target);
    };
    expect(distanceAt(0)).toBeCloseTo(20, 3);
    expect(distanceAt(0.02)).toBeCloseTo(20, 3); // 0.05 × 0.4 まで
    expect(distanceAt(0.1)).toBeCloseTo(150, 3); // 0.25 → 次の経由点（0.5）
    expect(distanceAt(0.2)).toBeCloseTo(150, 3);
    expect(distanceAt(0.3)).toBeCloseTo(325, 3); // 0.75 → 最後の経由点
    expect(distanceAt(0.4)).toBeCloseTo(325, 3);
    // 次の場面へ移る区間は、場面の終わりの構図のまま。次の場面の番号になったら切り替わる
    expect(distanceAt(0.9)).toBeCloseTo(325, 3);
    expect(distanceAt(1)).toBeCloseTo(2000, 3);
  });
});

describe('カメラリグ: 2 場面以上離れた位置へ一気に移る', () => {
  const key = (lat: number, distance: number): StoryCameraKeyframe => ({ target: { lat, lon: 139.76, alt: 0 }, distance, azimuthDeg: 0, elevationDeg: 60 });
  // 途中の場面（b・c）は遠くの俯瞰。a と d は近い
  const stages = [stage('a', key(35.68, 100)), stage('b', key(35.7, 30_000)), stage('c', key(35.72, 30_000)), stage('d', key(35.74, 100))];

  it('途中の場面を次々に映さず、目標の 1 場面手前から追いかける', () => {
    const { rig } = makeRig(stages, 1.5, { reducedMotion: () => false });
    rig.setHolds([0.4, 0.4, 0.4, 0.4]);
    rig.setPosition(0, true);
    rig.update(1 / 60);
    rig.setPosition(3);
    const onPathAfter = (from: number, pose: CameraPose): boolean => {
      // 姿勢が、経路の from 以降のどこかの点と一致する
      for (let k = 0; k <= 2000; k++) {
        const q = rig.poseAt(from + ((3 - from) * k) / 2000);
        if (Math.abs(q.distance - pose.distance) <= Math.max(1, pose.distance * 0.01) && Math.abs(q.target.z - pose.target.z) <= 5) return true;
      }
      return false;
    };
    for (let n = 0; n < 240; n++) {
      rig.update(1 / 60);
      expect(onPathAfter(2, rig.getPose())).toBe(true);
    }
    expect(rig.getPose().distance).toBeCloseTo(100, 3);
  });

  it('1 場面ぶんの移動は、これまでどおり経路を連続してたどる', () => {
    const { rig } = makeRig(stages, 1.5, { reducedMotion: () => false });
    rig.setHolds([0.4, 0.4, 0.4, 0.4]);
    rig.setPosition(0, true);
    rig.update(1 / 60);
    rig.setPosition(1);
    rig.update(1 / 60);
    // 1 フレーム目は、まだ場面 a の止まっている区間（距離 100 のまま）
    expect(rig.getPose().distance).toBeCloseTo(100, 3);
  });
});
