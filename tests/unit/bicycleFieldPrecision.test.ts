import { InstancedBufferGeometry, Matrix4, Mesh, PerspectiveCamera, Vector3, type BufferAttribute, type InterleavedBufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { BicycleField } from '../../src/scene/bicycle/field';
import { concatInstances, singleBicycle } from '../../src/scene/bicycle/layouts';

/**
 * 原点から遠い位置での描画の精度。
 * GPU の頂点シェーダーの計算（float32）を Math.fround で再現し、倍精度で計算した位置との差が
 * カメラを 1mm ずつ動かすあいだにどれだけ変動するか（画面上の震え）を測る。
 */
const f = Math.fround;
const W = 390;
const H = 844;

type Attr = BufferAttribute | InterleavedBufferAttribute;

/** three.js の頂点シェーダー（回転 → 平行移動 → modelView → projection）を float32 または倍精度で計算し、画面上の px を返す。 */
function project(
  mv: ArrayLike<number>,
  proj: ArrayLike<number>,
  v: Vector3,
  q: readonly number[],
  p: readonly number[],
  r: (x: number) => number,
): [number, number] {
  // bikeRotate: v + 2 cross(q.xyz, cross(q.xyz, v) + q.w v)
  const [qx, qy, qz, qw] = q as [number, number, number, number];
  const tx = r(r(r(qy * v.z) - r(qz * v.y)) + r(qw * v.x));
  const ty = r(r(r(qz * v.x) - r(qx * v.z)) + r(qw * v.y));
  const tz = r(r(r(qx * v.y) - r(qy * v.x)) + r(qw * v.z));
  const x = r(r(v.x + r(2 * r(r(qy * tz) - r(qz * ty)))) + p[0]!);
  const y = r(r(v.y + r(2 * r(r(qz * tx) - r(qx * tz)))) + p[1]!);
  const z = r(r(v.z + r(2 * r(r(qx * ty) - r(qy * tx)))) + p[2]!);
  const mul = (m: ArrayLike<number>, a: number, b: number, c: number, d: number): number[] =>
    [0, 1, 2, 3].map((row) => r(r(r(r(m[row]! * a) + r(m[4 + row]! * b)) + r(m[8 + row]! * c)) + r(m[12 + row]! * d)));
  const e = mul(mv, x, y, z, 1);
  const clip = mul(proj, e[0]!, e[1]!, e[2]!, e[3]!);
  return [r(r(clip[0]! / clip[3]!) * 0.5 + 0.5) * W, r(r(clip[1]! / clip[3]!) * 0.5 + 0.5) * H];
}

/** 描画用のメッシュから、ワールド位置が target に最も近いインスタンスを探す。 */
function findInstance(field: BicycleField, target: Vector3): { mesh: Mesh; q: number[]; p: number[] } {
  let best: { mesh: Mesh; q: number[]; p: number[]; d: number } | null = null;
  const w = new Vector3();
  field.object.updateMatrixWorld(true);
  field.object.traverse((o) => {
    if (!(o instanceof Mesh) || !o.visible || !(o.geometry instanceof InstancedBufferGeometry)) return;
    const g = o.geometry;
    const pos = g.getAttribute('iPos') as Attr | undefined;
    const quat = g.getAttribute('iQuat') as Attr | undefined;
    if (!pos || !quat) return;
    const n = Math.min(g.instanceCount, pos.count);
    for (let i = 0; i < n; i++) {
      w.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      const d = w.distanceTo(target);
      if (!best || d < best.d) {
        best = { mesh: o, d, p: [pos.getX(i), pos.getY(i), pos.getZ(i)], q: [quat.getX(i), quat.getY(i), quat.getZ(i), quat.getW(i)] };
      }
    }
  });
  if (!best) throw new Error('インスタンスが見つからない');
  expect((best as { d: number }).d).toBeLessThan(0.01);
  return best;
}

/** カメラを 1mm ずつ動かしたときの、画面上の誤差の変動の最大値(px)。 */
function measureJitter(field: BicycleField, target: Vector3, steps = 120): number {
  const camera = new PerspectiveCamera(50, W / H, 0.5, 200_000);
  const eye = target.clone().add(new Vector3(2.5, 1.6, 6.4)); // 距離 約7m
  const look = target.clone().add(new Vector3(0, 0.6, 0));
  const dir = new Vector3(1, 0.3, -0.4).normalize().multiplyScalar(0.001);
  let prev: [number, number][] | null = null;
  let worst = 0;
  for (let s = 0; s < steps; s++) {
    camera.position.copy(eye).addScaledVector(dir, s);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    field.update(camera, H);
    const inst = findInstance(field, target);
    const mvD = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, inst.mesh.matrixWorld).elements;
    const mvF = mvD.map(f);
    const projD = camera.projectionMatrix.elements;
    const projF = projD.map(f);
    const pos = inst.mesh.geometry.getAttribute('position');
    const errs: [number, number][] = [];
    const v = new Vector3();
    for (let k = 0; k < pos.count; k += Math.max(1, Math.floor(pos.count / 24))) {
      v.set(pos.getX(k), pos.getY(k), pos.getZ(k));
      const a = project(mvF, projF, v, inst.q, inst.p, f);
      const b = project(mvD, projD, v, inst.q, inst.p, (x) => x);
      errs.push([a[0] - b[0], a[1] - b[1]]);
    }
    if (prev) {
      for (let k = 0; k < errs.length; k++) {
        worst = Math.max(worst, Math.hypot(errs[k]![0] - prev[k]![0], errs[k]![1] - prev[k]![1]));
      }
    }
    prev = errs;
  }
  return worst;
}

describe('原点から遠い位置での描画の精度', () => {
  // 原点から西へ約59km（接平面なので地表は約 273m 下がる）
  const target = new Vector3(-59_000, -273, 1_500);
  const others = [
    singleBicycle(target, 0.4, 0x1d2a52),
    // 同じ区画の離れた位置にも置き、基準点が対象の自転車そのものにならないようにする
    singleBicycle({ x: -56_300, y: -255, z: 3_200 }, 0, 0xffffff),
    singleBicycle({ x: -59_900, y: -280, z: 200 }, 0, 0xffffff),
  ];

  for (const lod of [null, 2] as const) {
    it(`カメラを 1mm 動かしても画面上の震えが 0.1px 未満（詳細度 ${lod ?? '自動（近景）'}）`, () => {
      const field = new BicycleField();
      field.forceLod = lod;
      field.setInstances(concatInstances(...others));
      const jitter = measureJitter(field, target);
      console.info(`震えの最大値（詳細度 ${lod ?? 'auto'}）: ${jitter.toFixed(4)} px`);
      expect(jitter).toBeLessThan(0.1);
    });
  }
});
