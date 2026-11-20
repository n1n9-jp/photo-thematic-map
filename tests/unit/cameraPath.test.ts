import { describe, expect, it } from 'vitest';
import { ORIGIN } from '../../src/config';
import { latLonToLocal } from '../../src/geo/enu';
import {
  distanceForHeight,
  keyframeToPose,
  lerpPose,
  poseDelta,
  poseFromCamera,
  poseToCameraPosition,
  samplePath,
  smoothstep,
  type CameraPose,
} from '../../src/story/cameraPath';
import type { StoryCameraKeyframe } from '../../src/story/types';

const keyframes: StoryCameraKeyframe[] = [
  { target: { ...ORIGIN, alt: 5 }, distance: 35, azimuthDeg: 35, elevationDeg: 14 },
  { target: { ...ORIGIN, alt: 0 }, distance: 130, azimuthDeg: 35, elevationDeg: 50 },
  { target: { ...ORIGIN, alt: 0 }, distance: 1220, azimuthDeg: 35, elevationDeg: 55 },
  { target: { lat: ORIGIN.lat + 0.01, lon: ORIGIN.lon + 0.01, alt: 0 }, distance: 11540, azimuthDeg: 35, elevationDeg: 60 },
];
const poses = keyframes.map((k) => keyframeToPose(k));

function expectPoseClose(a: CameraPose, b: CameraPose): void {
  expect(a.target.x).toBeCloseTo(b.target.x, 6);
  expect(a.target.y).toBeCloseTo(b.target.y, 6);
  expect(a.target.z).toBeCloseTo(b.target.z, 6);
  expect(a.distance).toBeCloseTo(b.distance, 6);
  expect(a.azimuthDeg).toBeCloseTo(b.azimuthDeg, 6);
  expect(a.elevationDeg).toBeCloseTo(b.elevationDeg, 6);
}

describe('keyframeToPose', () => {
  it('緯度経度を enu.ts のローカル座標に変換する', () => {
    const p = keyframeToPose(keyframes[3] as StoryCameraKeyframe);
    const expected = latLonToLocal({ lat: ORIGIN.lat + 0.01, lon: ORIGIN.lon + 0.01, alt: 0 });
    expect(p.target).toEqual(expected);
    expect(p.target.x).toBeGreaterThan(0); // 東
    expect(p.target.z).toBeLessThan(0); // 北は -Z
  });
});

describe('poseToCameraPosition', () => {
  it('北向き・仰角0なら、注視点の南（+Z）の同じ高さにいる', () => {
    const pos = poseToCameraPosition({ target: { x: 0, y: 10, z: 0 }, distance: 50, azimuthDeg: 0, elevationDeg: 0 });
    expect(pos.x).toBeCloseTo(0);
    expect(pos.y).toBeCloseTo(10);
    expect(pos.z).toBeCloseTo(50);
  });

  it('東向きなら注視点の西（-X）にいる。仰角90なら真上', () => {
    const east = poseToCameraPosition({ target: { x: 0, y: 0, z: 0 }, distance: 20, azimuthDeg: 90, elevationDeg: 0 });
    expect(east.x).toBeCloseTo(-20);
    expect(east.z).toBeCloseTo(0);
    const top = poseToCameraPosition({ target: { x: 3, y: 0, z: 4 }, distance: 20, azimuthDeg: 30, elevationDeg: 90 });
    expect(top.x).toBeCloseTo(3);
    expect(top.y).toBeCloseTo(20);
    expect(top.z).toBeCloseTo(4);
  });

  it('poseFromCamera と往復して一致する', () => {
    for (const pose of poses) {
      const pos = poseToCameraPosition(pose);
      expectPoseClose(poseFromCamera(pos, pose.target), pose);
    }
  });
});

describe('distanceForHeight', () => {
  it('その距離・仰角でカメラの高さが指定どおりになる', () => {
    const d = distanceForHeight(1000, 55);
    const pos = poseToCameraPosition({ target: { x: 0, y: 0, z: 0 }, distance: d, azimuthDeg: 0, elevationDeg: 55 });
    expect(pos.y).toBeCloseTo(1000);
  });
});

describe('lerpPose', () => {
  it('端点でキーフレームと厳密に一致する', () => {
    const [a, b] = [poses[0] as CameraPose, poses[3] as CameraPose];
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
  });

  it('距離は対数空間で補間する（中点は幾何平均）', () => {
    const a = poses[0] as CameraPose;
    const b = poses[3] as CameraPose;
    expect(lerpPose(a, b, 0.5).distance).toBeCloseTo(Math.sqrt(a.distance * b.distance), 6);
  });

  it('方位角は最短回りで補間する（350° → 10° は 0° を通る）', () => {
    const base = poses[0] as CameraPose;
    const mid = lerpPose({ ...base, azimuthDeg: 350 }, { ...base, azimuthDeg: 10 }, 0.5);
    const d = Math.min(mid.azimuthDeg, 360 - mid.azimuthDeg);
    expect(d).toBeCloseTo(0, 6);
  });
});

describe('samplePath', () => {
  it('整数位置でキーフレームと一致する', () => {
    poses.forEach((pose, i) => expectPoseClose(samplePath(poses, i), pose));
  });

  it('範囲外は端のキーフレームに丸める', () => {
    expectPoseClose(samplePath(poses, -3), poses[0] as CameraPose);
    expectPoseClose(samplePath(poses, 99), poses[3] as CameraPose);
  });

  it('各キーフレームの手前の hold 区間では動かない', () => {
    expectPoseClose(samplePath(poses, 1.2, { hold: 0.3 }), poses[1] as CameraPose);
  });

  it('距離は位置に対して単調に増える（キーフレーム距離が増加する場合）', () => {
    let prev = -Infinity;
    for (let s = 0; s <= 3 + 1e-9; s += 0.01) {
      const d = samplePath(poses, s).distance;
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
  });

  it('距離が減っていくキーフレーム列では単調に減る', () => {
    const reversed = [...poses].reverse();
    let prev = Infinity;
    for (let s = 0; s <= 3 + 1e-9; s += 0.01) {
      const d = samplePath(reversed, s).distance;
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
  });

  it('キーフレームが1つだけならそれを返す', () => {
    expectPoseClose(samplePath([poses[0] as CameraPose], 0.7), poses[0] as CameraPose);
  });

  it('poses が空ならエラー', () => {
    expect(() => samplePath([], 0)).toThrow();
  });
});

describe('smoothstep / poseDelta', () => {
  it('smoothstep は端点が 0/1 で単調', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.25)).toBeLessThan(smoothstep(0.75));
  });

  it('同じ姿勢の差は 0', () => {
    expect(poseDelta(poses[1] as CameraPose, poses[1] as CameraPose)).toBe(0);
    expect(poseDelta(poses[0] as CameraPose, poses[3] as CameraPose)).toBeGreaterThan(1);
  });
});
