/**
 * 場面の 3D の中身の仮の表示。差し込みの型（SceneModule）が使えることを示すためのもので、
 * 本物の自転車・山（src/scene/bicycle/、src/sim/pile.ts）ができたら置き換える。
 *
 * - markers: 駅前に台数ぶんの小さな目印（自転車1台ぶんの大きさの箱）を並べる。
 * - pillars: 駅の位置に、台数に比例する高さの柱を立てる。
 * - cone: 円錐の山を置く。進捗に応じて体積が 0 から増える（高さ・直径は体積の3乗根で伸びる）。
 *
 * どれも、場面内の進捗が 0 から「カメラが止まっている区間の半分」に進む間に 0 から増え、場面にいる間だけ表示する。
 */
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { smoothstep } from '../story/cameraPath';
import type { SceneModule, SceneModuleContext } from './sceneModule';

/** 場面内の進捗から、中身の増え方(0〜1)。カメラが止まっている区間の前半で増えきる。 */
export function growthFor(progress: number, hold: number): number {
  const span = Math.max(hold * 0.5, 0.05);
  return smoothstep(progress / span);
}

abstract class PlaceholderModule implements SceneModule {
  protected ctx: SceneModuleContext | null = null;
  protected readonly group = new Group();
  protected readonly disposables: (BufferGeometry | Material)[] = [];
  private active = false;
  private growth = -1;

  constructor(readonly id: string) {
    this.group.name = `placeholder:${id}`;
    this.group.visible = false;
  }

  async init(ctx: SceneModuleContext): Promise<void> {
    this.ctx = ctx;
    await this.build(ctx);
    ctx.scene.add(this.group);
    this.applyGrowth(Math.max(this.growth, 0));
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.group.visible = active;
    this.ctx?.requestRender();
  }

  setProgress(progress: number): void {
    const g = growthFor(progress, this.ctx?.holdOf() ?? 0.4);
    if (g === this.growth) return;
    this.growth = g;
    if (!this.ctx) return;
    this.applyGrowth(g);
    this.ctx.requestRender();
  }

  /** 表示中の量（E2E と確認用）。 */
  get amount(): number {
    return Math.max(this.growth, 0);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }

  protected abstract build(ctx: SceneModuleContext): Promise<void>;
  protected abstract applyGrowth(g: number): void;
}

export interface MarkersOptions {
  id: string;
  lat: number;
  lon: number;
  /** 目印の数。 */
  count: number;
  /** 列の向き（方位, 度。北=0、東=90）。 */
  rowAzimuthDeg?: number;
  /** 1列の数。既定は count の平方根の2倍程度。 */
  perRow?: number;
  /** 並びの中心を (lat, lon) からずらす量(m)。カメラが並びの中に入らないようにするため。 */
  offsetNorthM?: number;
  offsetEastM?: number;
  color?: number;
}

/** 駅前に台数ぶんの小さな目印（長さ 1.8m・高さ 1.0m・幅 0.6m の箱）を並べる。 */
export class MarkersModule extends PlaceholderModule {
  private mesh: InstancedMesh | null = null;

  constructor(private readonly o: MarkersOptions) {
    super(o.id);
  }

  protected async build(ctx: SceneModuleContext): Promise<void> {
    const { lat, lon, count } = this.o;
    await ctx.elevationAt(lat, lon);
    const geometry = new BoxGeometry(0.6, 1.0, 1.8);
    geometry.translate(0, 0.5, 0);
    const material = new MeshLambertMaterial({ color: this.o.color ?? 0xe8442e });
    this.disposables.push(geometry, material);
    const mesh = new InstancedMesh(geometry, material, count);
    const center: { x: number; y: number; z: number } = ctx.toLocal(lat, lon, 0);
    center.x += this.o.offsetEastM ?? 0;
    center.z -= this.o.offsetNorthM ?? 0;
    const az = ((this.o.rowAzimuthDeg ?? 0) * Math.PI) / 180;
    // 列の向き（東=+X、北=−Z）と、それに直交する向き
    const along = new Vector3(Math.sin(az), 0, -Math.cos(az));
    const across = new Vector3(Math.cos(az), 0, Math.sin(az));
    const perRow = this.o.perRow ?? Math.max(1, Math.ceil(Math.sqrt(count * 3)));
    const rows = Math.ceil(count / perRow);
    const pitch = 0.75;
    const rowGap = 2.0;
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), across);
    const m = new Matrix4();
    const p = new Vector3();
    const one = new Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      p.copy(center)
        .addScaledVector(along, (col - (perRow - 1) / 2) * pitch)
        .addScaledVector(across, (row - (rows - 1) / 2) * rowGap);
      const ll = ctx.toLatLon(p.x, p.z);
      p.y = ctx.groundHeight(ll.lat, ll.lon);
      m.compose(p, q, one);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  protected applyGrowth(g: number): void {
    if (this.mesh) this.mesh.count = Math.round(this.o.count * g);
  }

  /** 表示中の目印の数。 */
  get shown(): number {
    return this.mesh?.count ?? 0;
  }
}

export interface PillarSpec {
  name: string;
  lat: number;
  lon: number;
  value: number;
  color?: number;
  /** 東へずらす量(m)（同じ駅に2本立てるとき）。 */
  offsetEastM?: number;
}

export interface PillarsOptions {
  id: string;
  /** 柱の一覧。非同期に読む（stations.json など）。 */
  load(): Promise<PillarSpec[]>;
  /** 値 1 あたりの高さ(m)。 */
  metersPerUnit: number;
  /** 柱の一辺(m)。 */
  widthM: number;
}

/** 駅の位置に、値に比例する高さの柱を立てる。 */
export class PillarsModule extends PlaceholderModule {
  private pillars: { mesh: Mesh; height: number }[] = [];

  constructor(private readonly o: PillarsOptions) {
    super(o.id);
  }

  protected async build(ctx: SceneModuleContext): Promise<void> {
    const specs = await this.o.load();
    const geometry = new BoxGeometry(this.o.widthM, 1, this.o.widthM);
    geometry.translate(0, 0.5, 0);
    this.disposables.push(geometry);
    const materials = new Map<number, MeshLambertMaterial>();
    for (const s of specs) {
      const ground = await ctx.elevationAt(s.lat, s.lon);
      const color = s.color ?? 0xe8442e;
      let material = materials.get(color);
      if (!material) {
        material = new MeshLambertMaterial({ color: new Color(color) });
        materials.set(color, material);
        this.disposables.push(material);
      }
      const mesh = new Mesh(geometry, material);
      const p = ctx.toLocal(s.lat, s.lon, ground);
      mesh.position.set(p.x + (s.offsetEastM ?? 0), p.y, p.z);
      mesh.name = `pillar:${s.name}`;
      this.group.add(mesh);
      this.pillars.push({ mesh, height: Math.max(s.value * this.o.metersPerUnit, 1) });
    }
  }

  protected applyGrowth(g: number): void {
    for (const { mesh, height } of this.pillars) {
      mesh.scale.y = Math.max(height * g, 1e-3);
      mesh.visible = g > 0;
    }
  }
}

export interface ConeOptions {
  id: string;
  lat: number;
  lon: number;
  heightM: number;
  diameterM: number;
  color?: number;
}

/** 円錐の山。裾は、足元の標高の最も低い所に合わせる（斜面でも浮かない）。 */
export class ConeModule extends PlaceholderModule {
  private mesh: Mesh | null = null;

  constructor(private readonly o: ConeOptions) {
    super(o.id);
  }

  protected async build(ctx: SceneModuleContext): Promise<void> {
    const { lat, lon, heightM, diameterM } = this.o;
    await ctx.elevationAt(lat, lon);
    const center = ctx.toLocal(lat, lon, 0);
    const r = diameterM / 2;
    let base = ctx.groundHeight(lat, lon);
    for (let k = 0; k < 16; k++) {
      for (const f of [0.5, 1]) {
        const a = (k / 16) * Math.PI * 2;
        const ll = ctx.toLatLon(center.x + Math.cos(a) * r * f, center.z + Math.sin(a) * r * f);
        base = Math.min(base, ctx.groundHeight(ll.lat, ll.lon));
      }
    }
    const geometry = new ConeGeometry(r, heightM, 96, 1, false);
    geometry.translate(0, heightM / 2, 0);
    const material = new MeshLambertMaterial({ color: this.o.color ?? 0xc9a66b });
    this.disposables.push(geometry, material);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(center.x, base, center.z);
    mesh.name = `cone:${this.id}`;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  protected applyGrowth(g: number): void {
    if (!this.mesh) return;
    // 体積が g に比例するよう、高さと直径を体積の3乗根で伸ばす
    const s = Math.max(Math.cbrt(g), 1e-3);
    this.mesh.scale.set(s, s, s);
    this.mesh.visible = g > 0;
  }
}
