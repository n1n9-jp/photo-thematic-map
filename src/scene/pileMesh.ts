/**
 * 堆積の厚さ格子から山の表面のメッシュを作る（描画用）。
 * 頂点はセルの中心（HeightGrid の座標規約に従う）。
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import type { HeightGrid } from '../sim/heightGrid';
import type { BoxBuilding } from '../sim/syntheticCity';

/** 堆積のない頂点を地表より少し下げる量(m)。地面とのちらつきを防ぐ。 */
const SINK = 0.05;

export interface PileMesh {
  mesh: Mesh;
  /** 厚さを差し替えて頂点を更新する（三角形の範囲は作成時の extent のまま）。 */
  update(thickness: Float32Array): void;
  dispose(): void;
}

/**
 * @param grid 地表の高さ格子
 * @param extent 描画する範囲を決める厚さ（成長させる場合は最終状態）。0 より大きいセルを含む四角形だけを張る。
 */
export function createPileMesh(grid: HeightGrid, extent: Float32Array, color = 0xc9a66b): PileMesh {
  const { width: w, height: h, cellSize: cs, originX, originZ } = grid;
  const positions = new Float32Array(w * h * 3);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 3;
      positions[i] = originX + (c + 0.5) * cs;
      positions[i + 2] = originZ + (r + 0.5) * cs;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = r * w + c;
      const b = a + 1;
      const d = a + w;
      const e = d + 1;
      if (
        (extent[a] as number) > 0 ||
        (extent[b] as number) > 0 ||
        (extent[d] as number) > 0 ||
        (extent[e] as number) > 0
      ) {
        // 上から見て反時計回り（法線が +Y）
        index.push(a, d, b, b, d, e);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(index);
  const material = new MeshStandardMaterial({ color, roughness: 0.95 });
  const mesh = new Mesh(geometry, material);

  const update = (thickness: Float32Array): void => {
    const g = grid.data;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const k = r * w + c;
        const t = thickness[k] as number;
        const gk = g[k] as number;
        let y: number;
        if (t > 0) {
          y = gk + t;
        } else {
          // 堆積のない頂点: 隣の山の表面より低い地表ならその少し下、
          // 露出した建物なら（建物の箱に隠れるので）隣の山の表面の高さに合わせる。
          let nb = -Infinity;
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= h) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc;
              if (cc < 0 || cc >= w) continue;
              const n = rr * w + cc;
              if ((thickness[n] as number) > 0) nb = Math.max(nb, (g[n] as number) + (thickness[n] as number));
            }
          }
          y = nb === -Infinity ? -SINK : Math.min(gk, nb) - SINK;
        }
        positions[k * 3 + 1] = y;
      }
    }
    geometry.attributes.position!.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  };
  update(extent);

  return {
    mesh,
    update,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** 箱型の建物を InstancedMesh にする。高さで明るさを変える。 */
export function createBuildingsMesh(buildings: readonly BoxBuilding[]): InstancedMesh {
  const geometry = new BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
  const mesh = new InstancedMesh(geometry, material, buildings.length);
  const m = new Matrix4();
  const color = new Color();
  const maxTop = buildings.reduce((a, b) => Math.max(a, b.top), 1);
  buildings.forEach((b, i) => {
    m.makeScale(b.x1 - b.x0, b.top, b.z1 - b.z0);
    m.setPosition((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
    mesh.setMatrixAt(i, m);
    const k = b.top / maxTop;
    color.setRGB(0.55 + 0.35 * k, 0.6 + 0.3 * k, 0.68 + 0.27 * k);
    mesh.setColorAt(i, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}
