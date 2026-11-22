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
  it('canvas の幅と高さで、縦長なら portrait を使い、横長に戻すと横長の値になる', () => {
    const { rig, camera, controls } = makeRig([stage('a', withPortrait)], 1280 / 720);
    rig.update(1);
    expect(rig.portrait).toBe(false);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(400, 3);

    rig.setFitFrame({ canvasWidth: 390, canvasHeight: 844, regionWidth: 390, regionHeight: 500 });
    rig.update(1);
    expect(rig.portrait).toBe(true);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(900, 3);
    expect(rig.getPose().azimuthDeg).toBeCloseTo(90, 6);

    rig.setFitFrame({ canvasWidth: 1280, canvasHeight: 720, regionWidth: 842, regionHeight: 720 });
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
