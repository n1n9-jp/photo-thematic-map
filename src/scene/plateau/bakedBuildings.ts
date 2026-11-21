/**
 * 変換済みの建物（`public/data/buildings/`。形式は `src/data/buildings.ts`）を読んで描く層。
 *
 * - カメラの位置に応じて、必要なチャンクだけを読み、離れたら解放する。
 *   - 詳細（detail, LOD2）: カメラか注視点から `levels.detail.viewDistanceM` 以内のセル（変換したセルに限る）。
 *   - 遠景（far, LOD1 の箱）: カメラから `maxDistanceM()` 以内のチャンク。チャンクの中のセルのうち、詳細を表示している
 *     セルの範囲は描かない（同じ建物を二重に描かない）。
 *   詳細と遠景を切り替えるときは、新しい方が読み終わるまで古い方を表示し続ける（穴が開かないように）。
 * - 見た目は直接読む経路（`PlateauBuildings`）と同じ: 共有の白いマテリアル（面ごとの陰影 flatShading、霧あり）。
 * - 頂点は 16bit の整数のまま GPU に送り、メッシュの位置と拡大で m に戻す。GPU へ転送した後は CPU 側の配列を解放する。
 * - 読めなかった場合（メタ情報やチャンクの 404 など）は、そのぶん建物なしで続け、警告を 1 件だけ出す。
 */
import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3 } from 'three';
import type { Camera, Material } from 'three';
import {
  buildingChunkPath,
  decodeBuildingChunk,
  isGzip,
  loadBuildingManifest,
  type BuildingChunkInfo,
  type BuildingChunkMesh,
  type BuildingManifest,
} from '../../data/buildings';
import { assetUrl } from '../../paths';
import { releaseAfterUpload } from './budget';
import { whiteBuildingMaterial } from './buildings';

export interface BakedBuildingsOptions {
  camera: Camera;
  /** 注視点（ローカル座標）。この周りのセルも詳細にする。既定はカメラだけ。 */
  lookAt?: () => { x: number; z: number } | null;
  /** 遠景を読む距離の上限(m)。毎フレーム呼ぶ。既定は変換した範囲（levels.far.viewDistanceM）。 */
  maxDistanceM?: () => number;
  material?: Material;
  /** メタ情報の URL。既定 `assetUrl('data/buildings/manifest.json')`。 */
  manifestUrl?: string;
  /** メタ情報（渡せば読まない。テスト用）。 */
  manifest?: BuildingManifest | null;
  /** 同時に読むチャンクの数。既定 6。 */
  concurrency?: number;
}

/** チャンクの索引（メタ情報から作る）。 */
export interface BakedIndex {
  detailSize: number;
  farSize: number;
  cellsPerFar: number;
  detailViewM: number;
  farViewM: number;
  /** 変換したセル（建物のないセルを含む）。 */
  detailCells: Set<string>;
  /** ファイルのあるチャンク（"level:ix_iz" → 情報）。 */
  files: Map<string, BuildingChunkInfo>;
  /** ファイルのある遠景のチャンク。 */
  farKeys: string[];
}

export function bakedIndex(m: BuildingManifest): BakedIndex {
  const files = new Map<string, BuildingChunkInfo>();
  for (const c of m.chunks) files.set(`${c.level}:${c.ix}_${c.iz}`, c);
  return {
    detailSize: m.levels.detail.chunkSizeM,
    farSize: m.levels.far.chunkSizeM,
    cellsPerFar: m.levels.far.cellsPerSide,
    detailViewM: m.levels.detail.viewDistanceM,
    farViewM: m.levels.far.viewDistanceM,
    detailCells: new Set(m.detailCells),
    files,
    farKeys: m.chunks.filter((c) => c.level === 'far').map((c) => `${c.ix}_${c.iz}`),
  };
}

function rectDistance(px: number, pz: number, x0: number, z0: number, s: number): number {
  const dx = Math.max(x0 - px, 0, px - (x0 + s));
  const dz = Math.max(z0 - pz, 0, pz - (z0 + s));
  return Math.hypot(dx, dz);
}

export interface BakedSelection {
  /** 表示したい詳細のセル（"ix_iz" → カメラからの距離）。 */
  detail: Map<string, number>;
  /** 表示したい遠景のチャンク（"ix_iz" → カメラからの距離）。 */
  far: Map<string, number>;
}

/**
 * カメラ（と注視点）の位置から、表示したいチャンクを選ぶ。
 * 詳細はカメラか注視点から detailViewM 以内の変換したセル、遠景はカメラから farMaxM 以内のチャンク。
 */
export function selectBakedChunks(
  index: BakedIndex,
  camera: { x: number; z: number },
  target: { x: number; z: number } | null,
  farMaxM: number,
): BakedSelection {
  const detail = new Map<string, number>();
  const far = new Map<string, number>();
  const s = index.detailSize;
  for (const k of index.detailCells) {
    const [i, j] = k.split('_').map(Number) as [number, number];
    const dc = rectDistance(camera.x, camera.z, i * s, j * s, s);
    const dt = target ? rectDistance(target.x, target.z, i * s, j * s, s) : Infinity;
    if (Math.min(dc, dt) <= index.detailViewM) detail.set(k, dc);
  }
  const f = index.farSize;
  const max = Math.min(farMaxM, index.farViewM);
  for (const k of index.farKeys) {
    const [i, j] = k.split('_').map(Number) as [number, number];
    const d = rectDistance(camera.x, camera.z, i * f, j * f, f);
    if (d <= max) far.set(k, d);
  }
  return { detail, far };
}

/** gzip を解く（配信側で展開済みならそのまま）。 */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 復号したチャンクからメッシュを作る。 */
export function chunkToMesh(c: BuildingChunkMesh, material: Material | Material[]): Mesh {
  const g = new BufferGeometry();
  const pos = new BufferAttribute(c.positions, 3);
  const index = new BufferAttribute(c.indices, 1);
  g.setAttribute('position', pos);
  g.setIndex(index);
  const max = [0, 0, 0];
  for (let i = 0; i < c.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) if ((c.positions[i + k] as number) > (max[k] as number)) max[k] = c.positions[i + k] as number;
  }
  g.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(max[0], max[1], max[2]));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new Sphere());
  releaseAfterUpload(pos);
  releaseAfterUpload(index);
  const mesh = new Mesh(g, material);
  mesh.position.set(c.origin[0], c.origin[1], c.origin[2]);
  mesh.scale.set(c.step[0], c.step[1], c.step[2]);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

type SlotState = 'queued' | 'loading' | 'ready' | 'failed';

interface Slot {
  level: 'detail' | 'far';
  key: string;
  state: SlotState;
  mesh: Mesh | null;
  /** 遠景: セルの群の範囲（三角形の番号。長さ cellsPerFar²+1）。 */
  groups: Uint32Array | null;
  /** 遠景: いま描かないセルの印（ビット）。 */
  hiddenMask: number;
  bytes: number;
  triangles: number;
  disposed: boolean;
  /** 読む順の優先度（カメラからの距離）。 */
  priority: number;
}

export interface BakedBuildingsStats {
  manifest: 'loading' | 'ready' | 'unavailable';
  detailChunks: number;
  farChunks: number;
  /** 表示している三角形の数（遠景で描かないセルを除く）。 */
  triangles: number;
  /** 読み込んだチャンクのファイルの大きさの合計(byte)。 */
  loadedBytes: number;
  failed: number;
}

export class BakedBuildings {
  readonly group = new Group();
  /** メタ情報を読み、最初に要るチャンクを読み終わると解決する（読めなくても解決する）。 */
  readonly ready: Promise<void>;
  isReady = false;

  private readonly camera: Camera;
  private readonly lookAt: (() => { x: number; z: number } | null) | undefined;
  private readonly maxDistanceM: (() => number) | undefined;
  private readonly material: Material;
  private readonly farMaterials: Material[];
  private readonly concurrency: number;
  private index: BakedIndex | null = null;
  private manifestState: 'loading' | 'ready' | 'unavailable' = 'loading';
  private readonly slots = new Map<string, Slot>();
  private active = 0;
  private failed = 0;
  private warned = false;
  private loadedBytes = 0;
  private resolveReady!: () => void;
  private updated = false;
  private disposed = false;
  private readonly camPos = new Vector3();

  constructor(options: BakedBuildingsOptions) {
    this.camera = options.camera;
    this.lookAt = options.lookAt;
    this.maxDistanceM = options.maxDistanceM;
    this.material = options.material ?? whiteBuildingMaterial();
    this.farMaterials = [this.material];
    this.concurrency = options.concurrency ?? 6;
    this.group.name = 'plateau-baked-buildings';
    this.ready = new Promise((r) => (this.resolveReady = r));
    if (options.manifest !== undefined) {
      this.setManifest(options.manifest);
    } else {
      void loadBuildingManifest(options.manifestUrl).then((m) => this.setManifest(m));
    }
  }

  private setManifest(m: BuildingManifest | null): void {
    if (this.disposed) return;
    if (!m) {
      this.manifestState = 'unavailable';
      this.warnOnce('メタ情報（data/buildings/manifest.json）を読めません');
      this.markReady();
      return;
    }
    this.index = bakedIndex(m);
    this.manifestState = 'ready';
  }

  private warnOnce(detail: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`変換済みの建物のデータを読めませんでした。建物なしで続けます（${detail}）。npm run data:buildings で作れます。`);
  }

  /** 毎フレーム、描画の前に呼ぶ。 */
  update(): void {
    this.updated = true;
    const index = this.index;
    if (!index) return;
    this.camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(this.camera.matrixWorld);
    const target = this.lookAt?.() ?? null;
    const farMax = this.maxDistanceM?.() ?? index.farViewM;
    const want = selectBakedChunks(index, this.camPos, target, farMax);

    // 要るものを足す
    for (const [k, d] of want.detail) this.ensure('detail', k, d);
    for (const [k, d] of want.far) this.ensure('far', k, d);

    // 要らなくなったものを外す。詳細は、その場所の遠景が読み終わるまで（または遠景も要らなくなるまで）残す
    const farOf = (cell: string): string => {
      const [i, j] = cell.split('_').map(Number) as [number, number];
      return `${Math.floor(i / index.cellsPerFar)}_${Math.floor(j / index.cellsPerFar)}`;
    };
    for (const slot of [...this.slots.values()]) {
      if (slot.level === 'far') {
        if (!want.far.has(slot.key)) this.remove(slot);
        continue;
      }
      if (want.detail.has(slot.key)) continue;
      const fk = farOf(slot.key);
      const far = this.slots.get(`far:${fk}`);
      const farWanted = want.far.has(fk) && index.files.has(`far:${fk}`);
      if (!farWanted || far?.state === 'ready' || far?.state === 'failed' || slot.state !== 'ready') this.remove(slot);
    }

    // 遠景で、詳細を表示しているセルを描かない
    for (const slot of this.slots.values()) {
      if (slot.level !== 'far' || slot.state !== 'ready' || !slot.mesh || !slot.groups) continue;
      const [fi, fj] = slot.key.split('_').map(Number) as [number, number];
      const n = index.cellsPerFar;
      let mask = 0;
      for (let s = 0; s < n * n; s++) {
        const cell = `${fi * n + (s % n)}_${fj * n + Math.floor(s / n)}`;
        if (this.slots.get(`detail:${cell}`)?.state === 'ready') mask |= 1 << s;
      }
      if (mask !== slot.hiddenMask) this.applyMask(slot, mask);
    }

    this.pump();
    if (!this.isReady && !this.isLoading) this.markReady();
  }

  private ensure(level: 'detail' | 'far', key: string, distance: number): void {
    const id = `${level}:${key}`;
    const existing = this.slots.get(id);
    if (existing) {
      existing.priority = distance;
      return;
    }
    const slot: Slot = { level, key, state: 'queued', mesh: null, groups: null, hiddenMask: 0, bytes: 0, triangles: 0, disposed: false, priority: distance };
    this.slots.set(id, slot);
    // 建物のないセル（ファイルなし）はすぐに読み終わったことにする
    if (!this.index?.files.has(id)) slot.state = 'ready';
  }

  private remove(slot: Slot): void {
    slot.disposed = true;
    this.slots.delete(`${slot.level}:${slot.key}`);
    if (slot.mesh) {
      slot.mesh.geometry.dispose();
      slot.mesh.removeFromParent();
      slot.mesh = null;
    }
  }

  /** 待っているチャンクを、近い順に、同時に concurrency 個まで読む。 */
  private pump(): void {
    if (this.active >= this.concurrency) return;
    const queued = [...this.slots.values()].filter((s) => s.state === 'queued');
    // 詳細を先に、同じ詳細度の中は近い順
    queued.sort((a, b) => (a.level === b.level ? a.priority - b.priority : a.level === 'detail' ? -1 : 1));
    for (const slot of queued) {
      if (this.active >= this.concurrency) break;
      void this.load(slot);
    }
  }

  private async load(slot: Slot): Promise<void> {
    slot.state = 'loading';
    this.active++;
    const [ix, iz] = slot.key.split('_').map(Number) as [number, number];
    const url = assetUrl(buildingChunkPath(slot.level, ix, iz));
    try {
      let bytes: Uint8Array | null = null;
      for (let attempt = 0; attempt < 3 && !bytes; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        if (slot.disposed) return;
        let res: Response;
        try {
          res = await fetch(url);
        } catch (err) {
          if (attempt === 2) throw err;
          continue;
        }
        if (res.status >= 500 && attempt < 2) continue;
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      if (!bytes || slot.disposed) return;
      slot.bytes = bytes.byteLength;
      this.loadedBytes += bytes.byteLength;
      const chunk = decodeBuildingChunk(await gunzip(bytes));
      if (slot.disposed) return;
      const mesh = chunkToMesh(chunk, slot.level === 'far' ? this.farMaterials : this.material);
      mesh.name = `buildings-${slot.level}-${slot.key}`;
      slot.triangles = chunk.indices.length / 3;
      if (slot.level === 'far') {
        slot.groups = chunk.groups;
        this.applyMask(slot, 0, mesh);
      }
      slot.mesh = mesh;
      slot.state = 'ready';
      this.group.add(mesh);
    } catch (err) {
      slot.state = 'failed';
      this.failed++;
      this.warnOnce(err instanceof Error ? err.message : String(err));
    } finally {
      this.active--;
    }
  }

  /** 遠景のチャンクの、描くセルの範囲を設定する（印のついたセルを描かない）。 */
  private applyMask(slot: Slot, mask: number, mesh = slot.mesh): void {
    slot.hiddenMask = mask;
    if (!mesh || !slot.groups) return;
    const g = mesh.geometry;
    g.clearGroups();
    const G = slot.groups;
    let start = -1;
    for (let s = 0; s < G.length - 1; s++) {
      const visible = (mask & (1 << s)) === 0;
      if (visible && start < 0) start = G[s] as number;
      if (!visible && start >= 0) {
        if ((G[s] as number) > start) g.addGroup(start * 3, ((G[s] as number) - start) * 3, 0);
        start = -1;
      }
    }
    if (start >= 0 && (G[G.length - 1] as number) > start) g.addGroup(start * 3, ((G[G.length - 1] as number) - start) * 3, 0);
    mesh.visible = g.groups.length > 0;
  }

  /** 読み込み中（メタ情報か、表示したいチャンク）なら true。 */
  get isLoading(): boolean {
    if (this.manifestState === 'loading') return true;
    if (this.manifestState === 'unavailable') return false;
    if (!this.updated) return true;
    for (const s of this.slots.values()) if (s.state === 'queued' || s.state === 'loading') return true;
    return false;
  }

  get failedCount(): number {
    return this.failed + (this.manifestState === 'unavailable' ? 1 : 0);
  }

  stats(): BakedBuildingsStats {
    let detailChunks = 0;
    let farChunks = 0;
    let triangles = 0;
    for (const s of this.slots.values()) {
      if (s.state !== 'ready' || !s.mesh) continue;
      if (s.level === 'detail') {
        detailChunks++;
        triangles += s.triangles;
      } else {
        farChunks++;
        if (s.mesh.visible) for (const g of s.mesh.geometry.groups) triangles += g.count / 3;
      }
    }
    return { manifest: this.manifestState, detailChunks, farChunks, triangles, loadedBytes: this.loadedBytes, failed: this.failedCount };
  }

  dispose(): void {
    this.disposed = true;
    for (const slot of [...this.slots.values()]) this.remove(slot);
    this.group.removeFromParent();
    this.markReady();
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    this.resolveReady();
  }
}

/** 本編で、変換済みの建物を使うか（URL に `?buildings=live` があれば PLATEAU から直接読む）。 */
export function buildingSourceFromUrl(search: string = typeof location === 'undefined' ? '' : location.search): 'baked' | 'live' {
  return new URLSearchParams(search).get('buildings') === 'live' ? 'live' : 'baked';
}

export type { BuildingChunkInfo };
