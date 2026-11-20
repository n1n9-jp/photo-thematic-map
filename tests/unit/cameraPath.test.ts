import { describe, expect, it } from 'vitest';
import { ORIGIN } from '../../src/config';
import { latLonToLocal } from '../../src/geo/enu';
import {
  clipPlanesFor,
  distanceForHeight,
  liftAboveGround,
  MAX_ELEVATION_DEG,
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
  it('注視点の Y は「地表の Y + 地表からの高さ」', () => {
    const k: StoryCameraKeyframe = { target: { lat: 35.698, lon: 139.773, alt: 31 }, distance: 300, azimuthDeg: 0, elevationDeg: 20 };
    const ground = latLonToLocal({ lat: 35.698, lon: 139.773, alt: 0 });
    const p = keyframeToPose(k);
    expect(p.target.x).toBeCloseTo(ground.x, 6);
    expect(p.target.z).toBeCloseTo(ground.z, 6);
    expect(p.target.y).toBeCloseTo(ground.y + 31, 6);
    // 地表の高さを渡すと、その上に載る
    expect(keyframeToPose(k, () => 40).target.y).toBeCloseTo(71, 6);
  });

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

  it('注視点が同じなら距離は対数空間で補間する（中点は幾何平均）', () => {
    const a = poses[1] as CameraPose;
    const b = poses[2] as CameraPose;
    expect(lerpPose(a, b, 0.5).distance).toBeCloseTo(Math.sqrt(a.distance * b.distance), 6);
  });

  it('仰角は MAX_ELEVATION_DEG を超えない', () => {
    const base = poses[1] as CameraPose;
    const mid = lerpPose({ ...base, elevationDeg: 80 }, { ...base, elevationDeg: 120 }, 0.7);
    expect(mid.elevationDeg).toBeLessThanOrEqual(MAX_ELEVATION_DEG);
    expect(keyframeToPose({ ...(keyframes[0] as StoryCameraKeyframe), elevationDeg: 90 }).elevationDeg).toBe(MAX_ELEVATION_DEG);
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

/** 経路上の各時点での「単位進捗あたりの注視点の移動量 ÷ その時点の距離」の最大値。 */
function maxPanRate(f: (t: number) => CameraPose): number {
  let max = 0;
  const h = 1e-4;
  for (let t = 0; t < 1; t += 0.0005) {
    const a = f(t);
    const b = f(Math.min(t + h, 1));
    const moved = Math.hypot(b.target.x - a.target.x, b.target.y - a.target.y, b.target.z - a.target.z);
    max = Math.max(max, moved / (Math.min(t + h, 1) - t) / a.distance);
  }
  return max;
}

/** 比較用: 注視点を線形、距離を対数で補間する（修正前の方式）。 */
function naiveLerp(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return {
    target: {
      x: a.target.x + (b.target.x - a.target.x) * t,
      y: a.target.y + (b.target.y - a.target.y) * t,
      z: a.target.z + (b.target.z - a.target.z) * t,
    },
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * t),
    azimuthDeg: a.azimuthDeg,
    elevationDeg: a.elevationDeg,
  };
}

const AKIHABARA = { lat: 35.69836, lon: 139.77313 };
const KOKYO_GAIEN = { lat: 35.6800, lon: 139.7570 };
/** 単位進捗あたりの見かけの移動量の上限。修正前の補間（注視点は線形）では、秋葉原 → 俯瞰で約 56 になる。 */
const MAX_PAN_RATE = 3;

describe('ズームとパンの連動（van Wijk–Nuij）', () => {
  const cases: [string, StoryCameraKeyframe, StoryCameraKeyframe][] = [
    [
      '秋葉原の距離120m → 6.7km 先・距離18km へ引く',
      { target: { ...AKIHABARA, alt: 0 }, distance: 120, azimuthDeg: 200, elevationDeg: 50 },
      { target: { lat: AKIHABARA.lat - 0.06, lon: AKIHABARA.lon + 0.0, alt: 0 }, distance: 18_000, azimuthDeg: 180, elevationDeg: 60 },
    ],
    [
      '23区の俯瞰（距離30km）→ 東京駅（距離300m）へ寄る',
      { target: { lat: 35.6895, lon: 139.6917, alt: 0 }, distance: 30_000, azimuthDeg: 0, elevationDeg: 60 },
      { target: { ...ORIGIN, alt: 15 }, distance: 300, azimuthDeg: 300, elevationDeg: 18 },
    ],
    [
      '東京駅（距離350m）→ 1km 離れた皇居外苑（距離900m）',
      { target: { ...ORIGIN, alt: 15 }, distance: 350, azimuthDeg: 300, elevationDeg: 15 },
      { target: { ...KOKYO_GAIEN, alt: 49 }, distance: 900, azimuthDeg: 120, elevationDeg: 12 },
    ],
  ];

  for (const [name, ka, kb] of cases) {
    it(name, () => {
      const a = keyframeToPose(ka);
      const b = keyframeToPose(kb);
      const rate0 = maxPanRate((t) => lerpPose(a, b, t));
      expect(rate0).toBeLessThanOrEqual(MAX_PAN_RATE);
      // 注視点を線形、距離を対数で補間した場合より、見かけの移動が速くならない
      expect(rate0).toBeLessThan(maxPanRate((t) => naiveLerp(a, b, t)));
      // 止まる区間と緩急をつけた経路でも、移る区間の長さ(1 - hold)で割った値が上限の 1.5 倍（smoothstep の最大の傾き）以下
      const hold = 0.5;
      const rate = maxPanRate((t) => samplePath([a, b], t, { hold }));
      expect(rate * (1 - hold)).toBeLessThanOrEqual(MAX_PAN_RATE * 1.5);
      // 端点はキーフレームに一致
      expectPoseClose(lerpPose(a, b, 1), b);
      expectPoseClose(samplePath([a, b], 0), a);
      const end = lerpPose(a, b, 1 - 1e-9);
      expect(Math.abs(end.distance - b.distance) / b.distance).toBeLessThan(1e-4);
    });
  }

  it('引く移動の序盤は、注視点がほとんど動かない', () => {
    const [, ka, kb] = cases[0]!;
    const a = keyframeToPose(ka);
    const b = keyframeToPose(kb);
    const p = lerpPose(a, b, 0.2);
    const moved = Math.hypot(p.target.x - a.target.x, p.target.z - a.target.z);
    expect(moved / p.distance).toBeLessThan(0.5);
  });
});

describe('samplePath の段階ごとの hold', () => {
  it('配列なら区間ごとの値を使う', () => {
    expectPoseClose(samplePath(poses, 1.7, { hold: [0.4, 0.8, 0.4] }), poses[1] as CameraPose);
    expect(poseDelta(samplePath(poses, 1.7, { hold: [0.4, 0.5, 0.4] }), poses[1] as CameraPose)).toBeGreaterThan(0.01);
  });
});

describe('liftAboveGround', () => {
  const ground = (): number => 10;
  it('地表より下なら仰角を上げて、地表から minClearance の高さにする', () => {
    const pose: CameraPose = { target: { x: 0, y: 11, z: 0 }, distance: 20, azimuthDeg: 0, elevationDeg: -10 };
    const lifted = liftAboveGround(pose, ground, 1.5);
    expect(poseToCameraPosition(lifted).y).toBeCloseTo(11.5, 6);
    expect(lifted.distance).toBe(20);
  });
  it('仰角の上限でも足りなければ距離を伸ばす', () => {
    const pose: CameraPose = { target: { x: 0, y: -100, z: 0 }, distance: 20, azimuthDeg: 0, elevationDeg: 30 };
    const lifted = liftAboveGround(pose, ground, 1);
    expect(lifted.elevationDeg).toBe(MAX_ELEVATION_DEG);
    expect(poseToCameraPosition(lifted).y).toBeCloseTo(11, 6);
  });
  it('十分高ければそのまま', () => {
    const pose = poses[2] as CameraPose;
    expect(liftAboveGround(pose, () => 0, 1)).toBe(pose);
  });
});

describe('clipPlanesFor', () => {
  it('接写から俯瞰まで、注視点が near と far の間に入る', () => {
    for (const [d, h] of [[6, 1.6], [200, 150], [1000, 300], [30_000, 26_000]] as const) {
      const { near, far } = clipPlanesFor(d, h);
      expect(near).toBeLessThan(d * 0.1);
      expect(far).toBeGreaterThan(d * 2);
      expect(far / near).toBeLessThan(1e6);
    }
  });
});
