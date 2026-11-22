/**
 * 自転車の足元の小さな色の印（上空から見下ろす場面で、1台が数ピクセルの点になっても台数の増え方が分かるように）。
 *
 * - 自転車1台ごとに、足元の地面に平たい円（既定 半径 0.75m）を置く。自転車そのものは実寸のまま。
 * - 現れた瞬間に印が大きく明るく光り、約1秒でもとの大きさに戻る（`setShown` で増えた分だけ、現れた時刻を書き込む）。
 * - `opacity` で全体の濃さを変える（地上の目線の場面では 0 にして描かない）。
 */
import {
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  type IUniform,
} from 'three';

export interface BikeMarkersOptions {
  /** 印の半径(m)。既定 0.75。 */
  radius?: number;
  /** 色。既定 0xff4a1c。 */
  color?: number;
  /** 光ったときの色。既定 0xfff2a8。 */
  flashColor?: number;
  /** 現れたときの拡大率（最大）。既定 3。 */
  flashScale?: number;
  /** 光が消えるまでの時定数(s)。既定 0.35。 */
  flashSeconds?: number;
}

export class BikeMarkers {
  readonly mesh: InstancedMesh;
  private readonly material: MeshBasicMaterial;
  private readonly born: InstancedBufferAttribute;
  private readonly uniforms: { uShown: IUniform<number>; uTime: IUniform<number>; uFlashScale: IUniform<number>; uFlashTau: IUniform<number>; uFlashColor: IUniform<Color>; uSize: IUniform<number> };
  private shown = 0;
  private timeSec = 0;
  private lastFlashSec = -Infinity;
  private readonly flashSeconds: number;

  /** positions はインスタンスの位置（x, y, z の並び）。y は地面の高さ。 */
  constructor(positions: ArrayLike<number>, count: number, options: BikeMarkersOptions = {}) {
    const radius = options.radius ?? 0.75;
    const geometry = new CircleGeometry(radius, 20);
    geometry.rotateX(-Math.PI / 2);
    this.flashSeconds = options.flashSeconds ?? 0.35;
    this.uniforms = {
      uShown: { value: 0 },
      uTime: { value: 0 },
      uFlashScale: { value: (options.flashScale ?? 3) - 1 },
      uFlashTau: { value: this.flashSeconds },
      uFlashColor: { value: new Color(options.flashColor ?? 0xfff2a8) },
      uSize: { value: 1 },
    };
    this.material = new MeshBasicMaterial({
      color: options.color ?? 0xff4a1c,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: true,
    });
    const u = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aRank;
attribute float aBorn;
uniform float uShown;
uniform float uTime;
uniform float uFlashScale;
uniform float uFlashTau;
uniform float uSize;
varying float vFlash;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
float markAge = max(uTime - aBorn, 0.0);
vFlash = aRank < uShown ? exp(-markAge / uFlashTau) : 0.0;
transformed *= aRank < uShown ? (1.0 + uFlashScale * vFlash) * uSize : 0.0;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uFlashColor;
varying float vFlash;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, uFlashColor, vFlash);`,
        );
    };
    this.material.customProgramCacheKey = () => 'akihabara-bike-markers';

    const mesh = new InstancedMesh(geometry, this.material, count);
    const m = new Matrix4();
    const rank = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // 地面から 3cm 浮かせる（地面の起伏の補間の差で潜らないように）
      m.makeTranslation(positions[i * 3]!, positions[i * 3 + 1]! + 0.03, positions[i * 3 + 2]!);
      mesh.setMatrixAt(i, m);
      rank[i] = i;
    }
    this.born = new InstancedBufferAttribute(new Float32Array(count).fill(-1e6), 1);
    this.born.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aRank', new InstancedBufferAttribute(rank, 1));
    geometry.setAttribute('aBorn', this.born);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.name = 'akihabara-bike-markers';
    this.mesh = mesh;
  }

  /** 表示する台数。増えた分は今の時刻に現れたことにする（光る）。flash=false なら光らせない。 */
  setShown(n: number, flash = true): void {
    const count = this.mesh.count;
    const next = Math.max(0, Math.min(count, Math.floor(n)));
    if (next === this.shown) return;
    if (next > this.shown) {
      const arr = this.born.array as Float32Array;
      const t = flash ? this.timeSec : -1e6;
      for (let i = this.shown; i < next; i++) arr[i] = t;
      this.born.addUpdateRange(this.shown, next - this.shown);
      this.born.needsUpdate = true;
      if (flash) this.lastFlashSec = this.timeSec;
    }
    this.shown = next;
    this.uniforms.uShown.value = next;
  }

  get shownCount(): number {
    return this.shown;
  }

  /** 全体の濃さ（0 で描かない）。 */
  /**
   * 印の大きさの倍率（既定 1）。遠くから見下ろす場面で、印が画面上で小さくなりすぎないように大きくする。
   */
  set sizeScale(v: number) {
    this.uniforms.uSize.value = v;
  }

  get sizeScale(): number {
    return this.uniforms.uSize.value;
  }

  set opacity(v: number) {
    this.material.opacity = v;
    this.mesh.visible = v > 0.001;
  }
  get opacity(): number {
    return this.mesh.visible ? this.material.opacity : 0;
  }

  /** 時刻を進める。光っている印があれば true（描画を続ける）。 */
  update(dtSec: number): boolean {
    this.timeSec += dtSec;
    this.uniforms.uTime.value = this.timeSec;
    return this.mesh.visible && this.timeSec - this.lastFlashSec < this.flashSeconds * 6;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
