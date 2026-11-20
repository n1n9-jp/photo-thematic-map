/**
 * 確認ページ: 焼き込んだ街の高さ格子（public/data/grids/）を陰影つきの立体で表示する。
 * URL パラメータ:
 * - `name` 地区（akihabara / marunouchi / shinjuku）。既定 marunouchi。
 * - `view` `top` で真上から、既定は南からの斜め見下ろし。`pile=1` のとき `close`（南東から山に寄る）・`closetop`（山の真上から寄る）。
 * - `pile` `1` で GRID_PILE_TRIALS の地点に堆積計算の山を積んで表示する（安息角 35°）。
 *
 * 色: 建物=明るい灰、橋梁・高架=青、地面=灰緑、標高データなし（主に水面: お濠・川）=水色。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
} from 'three';
import { createScene } from '../scene/createScene';
import { createPileMesh } from '../scene/pileMesh';
import {
  GRID_CLASS,
  GRID_NAMES,
  GRID_PILE_ANGLE,
  GRID_PILE_TRIALS,
  loadCityGrid,
  type CityGrid,
  type GridName,
} from '../data/grids';
import { latLonToLocal } from '../geo/enu';
import { countMissing, findOpenGround } from '../sim/heightGrid';
import { depositPiles } from '../sim/pile';

declare global {
  interface Window {
    __APP_READY__?: boolean;
    /** E2E・手動確認用。 */
    __GRID__?: {
      name: string;
      width: number;
      height: number;
      missing: number;
      classFractions: Record<string, number>;
      surfaceRange: [number, number];
      pile?: {
        volume: number;
        totalVolume: number;
        apexY: number;
        apexHeight: number;
        area: number;
        reachedEdge: boolean;
        warnings: number;
        ms: number;
      };
    };
  }
}

const params = new URLSearchParams(location.search);
const nameParam = params.get('name') ?? 'marunouchi';
const name: GridName = (GRID_NAMES as readonly string[]).includes(nameParam) ? (nameParam as GridName) : 'marunouchi';
const view = params.get('view');
const topView = view === 'top';
const withPile = params.get('pile') === '1';

/** 描画する頂点の一辺の最大数（大きな格子は間引く。間引くときはブロック内の最大を採る）。 */
const MAX_SIDE = 700;

const COLORS = {
  ground: new Color(0x9fa38f),
  building: new Color(0xe6e2da),
  bridge: new Color(0x5b80b8),
  nodata: new Color(0x5fa8c8),
};

function median(values: Float32Array): number {
  const a = Float32Array.from(values.filter((v) => !Number.isNaN(v))).sort();
  return a.length > 0 ? (a[a.length >> 1] as number) : 0;
}

/** 格子を高さ場のメッシュにする（頂点はセルの中心）。 */
function createCityMesh(g: CityGrid): Mesh {
  const { width: W, height: H, cellSize: cs, originX, originZ } = g.surface;
  const s = Math.max(1, Math.ceil(Math.max(W, H) / MAX_SIDE));
  const w = Math.ceil(W / s);
  const h = Math.ceil(H / s);
  const groundMedian = median(g.ground.data);
  const positions = new Float32Array(w * h * 3);
  const colors = new Float32Array(w * h * 3);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let best = -Infinity;
      let bestCell = (r * s) * W + c * s;
      for (let dr = 0; dr < s && r * s + dr < H; dr++) {
        for (let dc = 0; dc < s && c * s + dc < W; dc++) {
          const k = (r * s + dr) * W + c * s + dc;
          const v = g.surface.data[k] as number;
          if (v > best) {
            best = v;
            bestCell = k;
          }
        }
      }
      const i = r * w + c;
      positions[i * 3] = originX + (c * s + s / 2) * cs;
      positions[i * 3 + 1] = Number.isFinite(best) ? best : groundMedian;
      positions[i * 3 + 2] = originZ + (r * s + s / 2) * cs;
      const cls = g.classes[bestCell];
      let col: Color;
      if (cls === GRID_CLASS.building) col = COLORS.building;
      else if (cls === GRID_CLASS.bridge) col = COLORS.bridge;
      else if (cls === GRID_CLASS.nodata) col = COLORS.nodata;
      else col = COLORS.ground;
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
  }
  const index = new Uint32Array((w - 1) * (h - 1) * 6);
  let n = 0;
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = r * w + c;
      const b = a + 1;
      const d = a + w;
      const e = d + 1;
      index[n++] = a;
      index[n++] = d;
      index[n++] = b;
      index[n++] = b;
      index[n++] = d;
      index[n++] = e;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

async function main(): Promise<void> {
  const g = await loadCityGrid(name);
  const { width: W, height: H, cellSize: cs, originX, originZ } = g.surface;
  const n = W * H;
  const counts: Record<string, number> = { ground: 0, building: 0, bridge: 0, nodata: 0 };
  const byValue = Object.fromEntries(Object.entries(GRID_CLASS).map(([k, v]) => [v, k])) as Record<number, string>;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = byValue[g.classes[i] as number] ?? 'nodata';
    counts[k] = (counts[k] ?? 0) + 1;
    const v = g.surface.data[i] as number;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  window.__GRID__ = {
    name,
    width: W,
    height: H,
    missing: countMissing(g.surface),
    classFractions: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / n])),
    surfaceRange: [lo, hi],
  };

  const container = document.getElementById('app');
  if (!container) throw new Error('#app が見つかりません');
  const ctx = createScene(container, { referenceBox: false });
  ctx.scene.fog = null;
  // createScene の原点の地面（Y=0 の板）は格子の下に隠れるが、格子の外にはみ出すので消す。
  ctx.scene.children
    .filter((o: Object3D) => o instanceof Mesh && o.geometry.type === 'PlaneGeometry')
    .forEach((o) => (o.visible = false));
  ctx.scene.add(createCityMesh(g));

  let pileText = '';
  let pileFocus: { x: number; z: number; y: number; r: number } | null = null;
  const trial = GRID_PILE_TRIALS[name];
  if (withPile && trial) {
    const p = latLonToLocal({ lat: trial.lat, lon: trial.lon });
    const open = findOpenGround(g.surface, p.x, p.z, { radiusCells: 6, threshold: 1.5 });
    if (!open) throw new Error('開けた地表が見つかりません');
    const t0 = performance.now();
    const r = depositPiles(g.surface, [{ x: open.x, z: open.z, volume: trial.volume }], GRID_PILE_ANGLE);
    const ms = performance.now() - t0;
    const pile = r.piles[0];
    if (!pile) throw new Error('山の結果がありません');
    ctx.scene.add(createPileMesh(g.surface, r.thickness).mesh);
    let maxR = 0;
    for (let i = 0; i < r.thickness.length; i++) {
      if (!((r.thickness[i] as number) > 0)) continue;
      const x = originX + ((i % W) + 0.5) * cs;
      const z = originZ + (Math.floor(i / W) + 0.5) * cs;
      maxR = Math.max(maxR, Math.hypot(x - open.x, z - open.z));
    }
    pileFocus = { x: open.x, z: open.z, y: g.surface.data[open.row * W + open.col] as number, r: maxR };
    window.__GRID__.pile = {
      volume: trial.volume,
      totalVolume: r.totalVolume,
      apexY: pile.apexY,
      apexHeight: pile.apexHeight,
      area: pile.area,
      reachedEdge: r.reachedEdge,
      warnings: r.warnings.length,
      ms,
    };
    pileText =
      ` / 山: ${trial.label} ${Math.round(trial.volume).toLocaleString()} m³ 頂上 +${pile.apexHeight.toFixed(1)} m` +
      ` 面積 ${Math.round(pile.area).toLocaleString()} m²` +
      (r.reachedEdge ? ' ⚠ 格子の端に達しています' : '') +
      (r.warnings.length > 0 ? ` 警告 ${r.warnings.map((w) => w.kind).join(', ')}` : '') +
      ` (${ms.toFixed(0)} ms)`;
  }

  const cx = originX + (W * cs) / 2;
  const cz = originZ + (H * cs) / 2;
  const gy = median(g.ground.data);
  const size = Math.max(W, H) * cs;
  if (pileFocus && (view === 'close' || view === 'closetop')) {
    const d = Math.max(150, pileFocus.r * 2.6);
    ctx.controls.target.set(pileFocus.x, pileFocus.y, pileFocus.z);
    if (view === 'closetop') ctx.camera.position.set(pileFocus.x, pileFocus.y + d * 1.3, pileFocus.z + 0.01);
    else ctx.camera.position.set(pileFocus.x + d * 0.75, pileFocus.y + d * 0.6, pileFocus.z + d * 0.75);
  } else {
    ctx.controls.target.set(cx, gy, cz);
    if (topView) ctx.camera.position.set(cx, gy + size * 1.08, cz + 0.01);
    else ctx.camera.position.set(cx, gy + size * 0.62, cz + size * 0.82);
  }
  ctx.controls.update();

  const info = document.getElementById('info');
  if (info) {
    const f = window.__GRID__.classFractions;
    info.textContent =
      `${g.meta.name} ${W}×${H}（${cs} m）建物 ${((f.building ?? 0) * 100).toFixed(1)}% 橋梁 ${((f.bridge ?? 0) * 100).toFixed(1)}%` +
      ` 地面 Y 中央値 ${gy.toFixed(1)} m 生成 ${g.meta.generatedAt}` +
      pileText;
  }

  ctx.renderer.setAnimationLoop(ctx.render);
  ctx.render();
  requestAnimationFrame(() => {
    window.__APP_READY__ = true;
  });
}

main().catch((err: unknown) => {
  console.error(err);
});
