import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ORIGIN } from '../../src/config';
import { applyFit, distanceToFit, keyframeToPose, poseToCameraPosition, type FitFrame } from '../../src/story/cameraPath';
import { createCameraRig } from '../../src/story/cameraRig';
import { freeRegionFor, viewShiftFor } from '../../src/story/layout';
import { SCRIPT } from '../../src/story/content/script';
import type { StoryCameraKeyframe, StoryStage } from '../../src/story/types';

const FOV = 45;
const FIT = { eastWestM: 31_500, northSouthM: 33_000 };

/** 画面 width×height で、覆われていない範囲 region を中央にする投影のカメラ（本編と同じ setViewOffset）。 */
function projectCorners(
  pose: { azimuthDeg: number; elevationDeg: number; distance: number },
  fit: { eastWestM: number; northSouthM: number },
  width: number,
  height: number,
  region: { left: number; top: number; right: number; bottom: number },
): { x: number; y: number }[] {
  const camera = new PerspectiveCamera(FOV, width / height, 1, 1_000_000);
  const target = { x: 0, y: 0, z: 0 };
  const p = poseToCameraPosition({ target, ...pose });
  camera.position.set(p.x, p.y, p.z);
  camera.lookAt(0, 0, 0);
  const shift = viewShiftFor(region, width, height);
  camera.setViewOffset(1, 1, -shift.x, -shift.y, 1, 1);
  camera.aspect = width / height; // setViewOffset は aspect を 1 にする。カメラリグは戻している
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const out: { x: number; y: number }[] = [];
  for (const e of [-1, 1]) {
    for (const n of [-1, 1]) {
      // z は南向きが正（北が -z）
      const v = new Vector3((e * fit.eastWestM) / 2, 0, -(n * fit.northSouthM) / 2).project(camera);
      out.push({ x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height });
    }
  }
  return out;
}

const cases = [
  { name: 'PC 幅（1280×720、左に本文カードの列）', width: 1280, height: 720, region: { left: 438, top: 0, right: 1280, bottom: 720 } },
  { name: 'スマートフォン縦（390×844、下に本文カード）', width: 390, height: 844, region: { left: 0, top: 0, right: 390, bottom: 560 } },
  { name: '横長で本文カードなし', width: 1600, height: 700, region: { left: 0, top: 0, right: 1600, bottom: 700 } },
];

describe('distanceToFit', () => {
  for (const c of cases) {
    for (const angles of [
      { azimuthDeg: 0, elevationDeg: 60 },
      { azimuthDeg: 12, elevationDeg: 60 },
      { azimuthDeg: 90, elevationDeg: 35 },
      { azimuthDeg: 250, elevationDeg: 75 },
    ]) {
      it(`${c.name}・方位${angles.azimuthDeg}° 仰角${angles.elevationDeg}°: 4隅が範囲に収まり、いずれかが縁に接する`, () => {
        const frame: FitFrame = {
          fovDeg: FOV,
          canvasHeight: c.height,
          regionWidth: c.region.right - c.region.left,
          regionHeight: c.region.bottom - c.region.top,
        };
        const distance = distanceToFit(FIT, angles, frame);
        const corners = projectCorners({ ...angles, distance }, FIT, c.width, c.height, c.region);
        const eps = 0.01;
        for (const p of corners) {
          expect(p.x).toBeGreaterThanOrEqual(c.region.left - eps);
          expect(p.x).toBeLessThanOrEqual(c.region.right + eps);
          expect(p.y).toBeGreaterThanOrEqual(c.region.top - eps);
          expect(p.y).toBeLessThanOrEqual(c.region.bottom + eps);
        }
        const touch = Math.min(
          ...corners.flatMap((p) => [p.x - c.region.left, c.region.right - p.x, p.y - c.region.top, c.region.bottom - p.y]),
        );
        expect(touch).toBeLessThan(0.5);
        // 少しでも近づけると、はみ出す
        const closer = projectCorners({ ...angles, distance: distance * 0.98 }, FIT, c.width, c.height, c.region);
        expect(
          closer.some((p) => p.x < c.region.left || p.x > c.region.right || p.y < c.region.top || p.y > c.region.bottom),
        ).toBe(true);
      });
    }
  }

  it('範囲が広いほど、覆われていない範囲が狭いほど遠くなる', () => {
    const angles = { azimuthDeg: 0, elevationDeg: 60 };
    const frame: FitFrame = { fovDeg: FOV, canvasHeight: 720, regionWidth: 800, regionHeight: 700 };
    const base = distanceToFit(FIT, angles, frame);
    expect(distanceToFit({ eastWestM: 40_000, northSouthM: 33_000 }, angles, frame)).toBeGreaterThan(base);
    expect(distanceToFit(FIT, angles, { ...frame, regionWidth: 400 })).toBeGreaterThan(base);
    expect(distanceToFit(FIT, angles, { ...frame, regionHeight: 300 })).toBeGreaterThan(base);
  });
});

describe('applyFit', () => {
  const kf: StoryCameraKeyframe = { target: { ...ORIGIN, alt: 0 }, distance: 32_000, azimuthDeg: 0, elevationDeg: 60 };
  const pose = keyframeToPose(kf);
  const frame: FitFrame = { fovDeg: FOV, canvasHeight: 844, regionWidth: 390, regionHeight: 560 };

  it('fit がない・画面の大きさが未設定のときは、そのまま', () => {
    expect(applyFit(pose, undefined, frame)).toBe(pose);
    expect(applyFit(pose, FIT, null)).toBe(pose);
  });

  it('fit から求めた距離が下限より大きければ、それを使う。小さければ下限のまま', () => {
    const fitted = applyFit(pose, FIT, frame);
    expect(fitted.distance).toBeCloseTo(distanceToFit(FIT, pose, frame), 6);
    expect(fitted.distance).toBeGreaterThan(pose.distance);
    expect(fitted.target).toEqual(pose.target);
    const far = { ...pose, distance: 500_000 };
    expect(applyFit(far, FIT, frame)).toBe(far);
  });
});

describe('台本の fit', () => {
  it('場面3・4（23区の俯瞰）は同じ長方形の範囲を指す（ほかの場面の fit は、収めたい点の集まり）', () => {
    const rect = SCRIPT.filter((s) => s.camera.fit !== undefined && !s.camera.fit.points);
    expect(rect.map((s) => s.id)).toEqual(['tokyo-13394', 'parking-vacancy']);
    expect(rect[0]!.camera.fit).toEqual(rect[1]!.camera.fit);
  });

  it('PC 幅でもスマートフォン縦でも、23区の駅の範囲（約 30km 四方）が収まる距離になる', () => {
    const kf = SCRIPT.find((s) => s.id === 'tokyo-13394')!.camera;
    const pose = keyframeToPose(kf);
    const pc = applyFit(pose, kf.fit, { fovDeg: FOV, canvasHeight: 720, regionWidth: 842, regionHeight: 720 });
    const phone = applyFit(pose, kf.fit, { fovDeg: FOV, canvasHeight: 844, regionWidth: 390, regionHeight: 560 });
    expect(pc.distance).toBeGreaterThan(pose.distance);
    expect(phone.distance).toBeGreaterThan(pc.distance);
    // 画面の幅が狭いほど遠くなるが、無制限には遠くならない（遠方の描画範囲 400km に収まる）
    expect(phone.distance).toBeLessThan(150_000);
  });
});

describe('カメラリグの setFitFrame', () => {
  const kf = SCRIPT.find((s) => s.id === 'tokyo-13394')!.camera;
  const stages: StoryStage[] = [
    { id: 'a', text: { heading: 'a', paragraphs: [] }, camera: { target: { ...ORIGIN, alt: 0 }, distance: 500, azimuthDeg: 0, elevationDeg: 30 } },
    { id: 'b', text: { heading: 'b', paragraphs: [] }, camera: kf },
  ];

  function makeRig() {
    const camera = new PerspectiveCamera(FOV, 390 / 844, 1, 100_000);
    const target = new Vector3();
    const controls = {
      addEventListener() {},
      removeEventListener() {},
      update() {},
      target,
      enabled: true,
      enableZoom: true,
      minPolarAngle: 0,
      touches: {},
    } as unknown as OrbitControls;
    const style: Record<string, string> = {};
    const rig = createCameraRig({ camera, controls, renderer: { domElement: { style } as unknown as HTMLElement } }, stages, {
      reducedMotion: () => true,
    });
    return { rig, camera, controls };
  }

  it('画面の大きさを伝えるまでは distance のまま、伝えると fit の距離になる', () => {
    const { rig, camera, controls } = makeRig();
    rig.setPosition(1, true);
    rig.update(1);
    const before = camera.position.distanceTo(controls.target);
    expect(before).toBeCloseTo(kf.distance, 3);

    rig.setFitFrame({ canvasHeight: 844, regionWidth: 390, regionHeight: 560 });
    rig.update(1);
    const phone = camera.position.distanceTo(controls.target);
    expect(phone).toBeGreaterThan(before);
    expect(phone).toBeCloseTo(applyFit(keyframeToPose(kf), kf.fit, { fovDeg: FOV, canvasHeight: 844, regionWidth: 390, regionHeight: 560 }).distance, 3);

    // 横長の画面では、より近い
    rig.setFitFrame({ canvasHeight: 720, regionWidth: 842, regionHeight: 720 });
    rig.update(1);
    const pc = camera.position.distanceTo(controls.target);
    expect(pc).toBeLessThan(phone);
    expect(pc).toBeGreaterThanOrEqual(kf.distance);

    // fit のない場面（0）は変わらない
    rig.setPosition(0, true);
    rig.update(1);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(500, 3);
  });

  it('freeRegionFor の覆われていない範囲の大きさをそのまま使える', () => {
    const region = freeRegionFor({ layout: 'bottom', width: 390, height: 844, visibleHeight: 844, columnRight: 374, coverTop: 600 });
    expect(region.right - region.left).toBe(390);
    expect(region.bottom).toBe(584);
  });
});
