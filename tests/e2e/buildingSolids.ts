/**
 * 変換済みの建物（public/data/buildings/）を Node で読み、点が建物の中にあるかを調べる（場面の間の移動の確認用）。
 *
 * 建物の形は床（地面に接する下向きの面）を捨ててあるので、点から真上へ伸ばした半直線が横切る面の数で判定する:
 * 建物の中なら屋根を 1 回（奇数回）横切り、建物の外（上空・高架の下など）なら 0 回か偶数回。
 * 詳細（LOD2）と遠景（LOD1 の箱）のどちらかで中にあれば「中」とする。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  decodeBuildingChunk,
  isGzip,
  type BuildingChunkInfo,
  type BuildingLevel,
  type BuildingManifest,
} from '../../src/data/buildings';

/** 公開ルート（E2E はリポジトリの直下で動く）。 */
const ROOT = join(process.env.PTM_ROOT ?? process.cwd(), 'public');
/** 三角形を振り分ける格子の一辺(m)。 */
const GRID_M = 10;
/** 建物は足元の中心でチャンクに割り当てられ、形はチャンクの外へはみ出すので、この距離(m)まで隣のチャンクも調べる。 */
const OVERHANG_M = 150;

interface LoadedChunk {
  info: BuildingChunkInfo;
  /** 三角形の頂点（9 個で 1 三角形、ローカル座標 m）。 */
  tris: Float64Array;
  /** 格子のセル → 三角形の番号。 */
  grid: Map<string, number[]>;
}

export class BuildingSolids {
  readonly manifest: BuildingManifest;
  private readonly byKey = new Map<string, BuildingChunkInfo>();
  private readonly loaded = new Map<string, LoadedChunk>();

  constructor() {
    this.manifest = JSON.parse(readFileSync(join(ROOT, 'data/buildings/manifest.json'), 'utf8')) as BuildingManifest;
    for (const c of this.manifest.chunks) this.byKey.set(`${c.level}:${c.ix}_${c.iz}`, c);
  }

  private load(info: BuildingChunkInfo): LoadedChunk {
    const key = `${info.level}:${info.ix}_${info.iz}`;
    const hit = this.loaded.get(key);
    if (hit) return hit;
    let bytes: Uint8Array = readFileSync(join(ROOT, info.path));
    if (isGzip(bytes)) bytes = gunzipSync(bytes);
    const m = decodeBuildingChunk(bytes);
    const T = m.indices.length / 3;
    const tris = new Float64Array(T * 9);
    const grid = new Map<string, number[]>();
    for (let t = 0; t < T; t++) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = m.indices[t * 3 + k]!;
        for (let a = 0; a < 3; a++) tris[t * 9 + k * 3 + a] = m.origin[a]! + m.positions[v * 3 + a]! * m.step[a]!;
        const x = tris[t * 9 + k * 3]!;
        const z = tris[t * 9 + k * 3 + 2]!;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      for (let gz = Math.floor(z0 / GRID_M); gz <= Math.floor(z1 / GRID_M); gz++) {
        for (let gx = Math.floor(x0 / GRID_M); gx <= Math.floor(x1 / GRID_M); gx++) {
          const k = `${gx}_${gz}`;
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(t);
        }
      }
    }
    const out = { info, tris, grid };
    this.loaded.set(key, out);
    return out;
  }

  /** 点 (x, y, z) の上にある、点の高さより上に届くチャンク（詳細度ごと）。 */
  private chunksAt(level: BuildingLevel, x: number, y: number, z: number): LoadedChunk[] {
    const size = this.manifest.levels[level].chunkSizeM;
    const out: LoadedChunk[] = [];
    for (let iz = Math.floor((z - OVERHANG_M) / size); iz <= Math.floor((z + OVERHANG_M) / size); iz++) {
      for (let ix = Math.floor((x - OVERHANG_M) / size); ix <= Math.floor((x + OVERHANG_M) / size); ix++) {
        const info = this.byKey.get(`${level}:${ix}_${iz}`);
        if (info && info.maxY > y) out.push(this.load(info));
      }
    }
    return out;
  }

  /** 点から真上への半直線が横切る面の数（詳細度ごと）。 */
  crossingsAbove(level: BuildingLevel, x: number, y: number, z: number): number {
    let n = 0;
    const cell = `${Math.floor(x / GRID_M)}_${Math.floor(z / GRID_M)}`;
    for (const c of this.chunksAt(level, x, y, z)) {
      for (const t of c.grid.get(cell) ?? []) {
        const p = c.tris;
        const o = t * 9;
        const ax = p[o]!, ay = p[o + 1]!, az = p[o + 2]!;
        const bx = p[o + 3]!, by = p[o + 4]!, bz = p[o + 5]!;
        const cx = p[o + 6]!, cy = p[o + 7]!, cz = p[o + 8]!;
        // xz 平面での重心座標
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const h = l1 * ay + l2 * by + l3 * cy;
        if (h > y) n++;
      }
    }
    return n;
  }

  /** 点が建物の中にあるか（詳細か遠景のどちらかで、真上の半直線が奇数回面を横切る）。 */
  inside(x: number, y: number, z: number): boolean {
    return this.crossingsAbove('detail', x, y, z) % 2 === 1 || this.crossingsAbove('far', x, y, z) % 2 === 1;
  }
}
