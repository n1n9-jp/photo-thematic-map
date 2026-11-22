/**
 * PlateauGround のタイルの選び方を、偽の renderer と偽の画像・標高の取得で Node 上で確かめる。
 * - 途中の段を飛ばしても、表示中のタイルが範囲と視野を隙間なく・重なりなく覆う。
 * - 子の取得に失敗した範囲には、祖先の画像が表示される。
 * - カメラを動かしてから止めると、読み込みが落ち着く。移動中と停止後で地面の高さが変わらない。
 */
import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Plane, Ray, Raycaster, Vector3 } from 'three';
import type { WebGLRenderer } from 'three';
import { latLonToLocal, localToLatLon } from '../../src/geo/enu';
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from '../../src/geo/tiles';
import type { FetchPixels } from '../../src/scene/plateau/elevation';
import { PlateauGround, regionAny, regionSolid } from '../../src/scene/plateau/ground';

const W = 800;
const H = 600;
const renderer = {
  getSize: (v: { set(x: number, y: number): unknown }) => v.set(W, H),
  capabilities: { getMaxAnisotropy: () => 8 },
} as unknown as WebGLRenderer;

type Height = (lat: number, lon: number) => number;
const FLAT: Height = () => 20;
/** 波打つ起伏（振幅 8m、波長 数百 m）。平面ではないので、粗いタイルのメッシュでは高さが変わる。 */
const HILLS: Height = (lat, lon) => {
  const p = latLonToLocal({ lat, lon });
  return 20 + 8 * Math.sin(p.x / 60) * Math.cos(p.z / 45);
};

interface FakeOptions {
  height?: Height;
  /** 取得できない航空写真のタイル（'z/x/y'）。 */
  fail?: Set<string>;
}

/** 偽の取得。航空写真は全面不透明、標高は height を国土地理院の符号化で返す。取得した URL を記録する。 */
function fakeFetch(opts: FakeOptions = {}): { fetch: FetchPixels; log: string[] } {
  const log: string[] = [];
  const height = opts.height ?? FLAT;
  const fetch: FetchPixels = async (url) => {
    await Promise.resolve();
    const m = /\/(\d+)\/(\d+)\/(\d+)\.(png|jpg)$/.exec(url);
    if (!m) throw new Error(`unexpected url ${url}`);
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const bitmap = { width: 256, height: 256, close: () => undefined } as unknown as ImageBitmap;
    const pixels = new Uint8ClampedArray(256 * 256 * 4);
    if (url.includes('/dem')) {
      log.push(`dem ${url.includes('dem5a') ? 'dem5a' : 'dem10'} ${z}/${x}/${y}`);
      for (let j = 0; j < 256; j++) {
        const lat = tileYToLat(y + (j + 0.5) / 256, z);
        for (let i = 0; i < 256; i++) {
          const v = Math.round(height(lat, tileXToLon(x + (i + 0.5) / 256, z)) * 100);
          const k = (j * 256 + i) * 4;
          pixels[k] = (v >> 16) & 255;
          pixels[k + 1] = (v >> 8) & 255;
          pixels[k + 2] = v & 255;
          pixels[k + 3] = 255;
        }
      }
      return { bitmap, pixels };
    }
    const key = `${z}/${x}/${y}`;
    log.push(`ortho ${key}`);
    if (opts.fail?.has(key)) throw Object.assign(new Error(`failed ${key}`), { name: 'TileUnavailableError' });
    pixels.fill(255);
    return { bitmap, pixels };
  };
  return { fetch, log };
}

function makeCamera(pos: Vector3, target: Vector3): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, W / H, 1, 50_000);
  camera.position.copy(pos);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

function makeGround(camera: PerspectiveCamera, fetch: FetchPixels): PlateauGround {
  return new PlateauGround({
    camera,
    renderer,
    radiusM: 1500,
    minZoom: 13,
    maxZoom: 18,
    maxTiles: 2000,
    elevationMaxTiles: 500,
    texelScale: 1.5,
    ortho: 'plateau',
    fetchPixels: fetch,
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 読み込みが落ち着く（needsUpdate が偽のまま 20 フレーム続く）まで update する。 */
async function settle(g: PlateauGround, maxFrames = 5000): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxFrames; i++) {
    g.update();
    await tick();
    quiet = g.needsUpdate ? 0 : quiet + 1;
    if (quiet >= 20 && g.isReady) return;
  }
  throw new Error('落ち着かない');
}

type Tile = { z: number; x: number; y: number };
const contains = (t: Tile, lat: number, lon: number): boolean =>
  Math.floor(lonToTileX(lon, t.z)) === t.x && Math.floor(latToTileY(lat, t.z)) === t.y;
const isAncestor = (a: Tile, b: Tile): boolean => a.z < b.z && b.x >> (b.z - a.z) === a.x && b.y >> (b.z - a.z) === a.y;

/** 視野の中の地面（高さ groundY の平面）の点。カメラの真下から radiusM 以内。 */
function groundSamples(camera: PerspectiveCamera, groundY: number, radiusM: number): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = [];
  const plane = new Plane(new Vector3(0, 1, 0), -groundY);
  for (let v = -0.98; v <= 0.98; v += 0.07) {
    for (let u = -0.98; u <= 0.98; u += 0.07) {
      const p = new Vector3(u, v, 0.5).unproject(camera);
      const ray = new Ray(camera.position.clone(), p.sub(camera.position).normalize());
      const hit = ray.intersectPlane(plane, new Vector3());
      if (!hit) continue;
      if (Math.hypot(hit.x - camera.position.x, hit.z - camera.position.z) > radiusM * 0.98) continue;
      const ll = localToLatLon({ x: hit.x, y: 0, z: hit.z });
      out.push({ lat: ll.lat, lon: ll.lon });
    }
  }
  return out;
}

function expectCovered(g: PlateauGround, camera: PerspectiveCamera, groundY: number): Tile[] {
  const visible = g.debugTiles().filter((t) => t.visible);
  for (const a of visible) for (const b of visible) expect(isAncestor(a, b)).toBe(false);
  const samples = groundSamples(camera, groundY, 1500);
  expect(samples.length).toBeGreaterThan(100);
  for (const s of samples) {
    const n = visible.filter((t) => contains(t, s.lat, s.lon)).length;
    expect(n, `${s.lat},${s.lon}`).toBe(1);
  }
  return visible;
}

/** 地点の地面のメッシュの高さ（表示中のタイルを上から下へ射る）。 */
function meshHeightAt(g: PlateauGround, x: number, z: number): number {
  g.group.updateMatrixWorld(true);
  const meshes = g.group.children.filter((o): o is Mesh => o instanceof Mesh && o.visible);
  const rc = new Raycaster(new Vector3(x, 5000, z), new Vector3(0, -1, 0));
  const hit = rc.intersectObjects(meshes, false)[0];
  if (!hit) throw new Error('地面がない');
  return hit.point.y;
}

const ORIGIN_VIEW = { pos: new Vector3(0, 400, 600), target: new Vector3(0, 20, 0) };

describe('PlateauGround のタイルの選び方', () => {
  it('途中の段を飛ばしても、表示中のタイルが範囲と視野を隙間なく・重なりなく覆う', async () => {
    const camera = makeCamera(ORIGIN_VIEW.pos, ORIGIN_VIEW.target);
    const { fetch, log } = fakeFetch();
    const g = makeGround(camera, fetch);
    await settle(g);
    const visible = expectCovered(g, camera, 20);
    expect(Math.max(...visible.map((t) => t.z))).toBeGreaterThanOrEqual(16);
    // 途中の段を飛ばしている（親を読まずに読んだタイルがある）
    const ortho = new Set(log.filter((l) => l.startsWith('ortho ')).map((l) => l.slice(6)));
    const skippedParent = [...ortho].some((k) => {
      const [z, x, y] = k.split('/').map(Number) as [number, number, number];
      return z > 13 && !ortho.has(`${z - 1}/${x >> 1}/${y >> 1}`);
    });
    expect(skippedParent).toBe(true);
    g.dispose();
  });

  it('子の1枚が取得できないとき、その範囲に祖先の画像が表示され、隙間ができない', async () => {
    const camera = makeCamera(ORIGIN_VIEW.pos, ORIGIN_VIEW.target);
    // まず失敗なしで、注視点の真下に表示される細かいタイルを調べる
    const probe = makeGround(camera, fakeFetch().fetch);
    await settle(probe);
    const ll = localToLatLon({ x: 0, y: 0, z: 0 });
    const shown = probe.debugTiles().find((t) => t.visible && contains(t, ll.lat, ll.lon))!;
    probe.dispose();
    expect(shown.z).toBeGreaterThanOrEqual(15);

    const failKey = `${shown.z}/${shown.x}/${shown.y}`;
    const { fetch, log } = fakeFetch({ fail: new Set([failKey]) });
    const g = makeGround(camera, fetch);
    await settle(g);
    expect(log).toContain(`ortho ${failKey}`);
    const visible = expectCovered(g, camera, 20);
    const here = visible.find((t) => contains(t, ll.lat, ll.lon))!;
    expect(isAncestor(here, shown)).toBe(true);
    g.dispose();
  });

  it('カメラを動かしてから止めると、needsUpdate が偽になり ready が解決する', async () => {
    const camera = makeCamera(ORIGIN_VIEW.pos, ORIGIN_VIEW.target);
    const g = makeGround(camera, fakeFetch().fetch);
    let resolved = false;
    void g.ready.then(() => (resolved = true));
    for (let i = 0; i < 40; i++) {
      camera.position.x += 5;
      camera.updateMatrixWorld();
      g.update();
      await tick();
      // 最初のフレームは比べる前のフレームがないので、2 フレーム目から「動いている」になる
      if (i > 0) expect(g.needsUpdate).toBe(true);
    }
    expect(resolved).toBe(false);
    await settle(g);
    await tick();
    expect(g.needsUpdate).toBe(false);
    expect(resolved).toBe(true);
    g.dispose();
  });

  it('移動中と停止後で、同じ地点の地面のメッシュの高さが同じ', async () => {
    const camera = makeCamera(new Vector3(0, 170, 60), new Vector3(0, 20, 0));
    const g = makeGround(camera, fakeFetch({ height: HILLS }).fetch);
    await settle(g);
    const q = latLonToLocal(localToLatLon({ x: 0, y: 0, z: 40 }));
    const settled = meshHeightAt(g, q.x, q.z);
    const qll = localToLatLon({ x: q.x, y: 0, z: q.z });
    /** 地点 Q を含む表示中のタイル。 */
    const shown = (): string =>
      g
        .debugTiles()
        .filter((t) => t.visible && contains(t, qll.lat, qll.lon))
        .map((t) => `${t.z}/${t.x}/${t.y}`)
        .join(',');
    const before = shown();
    expect(Number(before.split('/')[0])).toBe(18);
    // 少しずつ動かす（移動中）。Q を表示するタイルは変わらない
    for (let i = 0; i < 15; i++) {
      camera.position.x += 1;
      camera.updateMatrixWorld();
      g.update();
      await tick();
      expect(g.needsUpdate).toBe(true);
      expect(meshHeightAt(g, q.x, q.z)).toBeCloseTo(settled, 6);
      expect(shown()).toBe(before);
    }
    await settle(g);
    expect(meshHeightAt(g, q.x, q.z)).toBeCloseTo(settled, 6);
    g.dispose();
  });
});

describe('祖先の画像の区画による子孫の判断', () => {
  const grid = (cells: [number, number][]): Uint8Array => {
    const g = new Uint8Array(64);
    for (const [i, j] of cells) g[j * 8 + i] = 1;
    return g;
  };

  it('深さ1〜3の区画の対応（深さ1は4×4区画、2は2×2区画、3は1区画）', () => {
    const g = grid([[7, 7]]); // 南東の端の区画だけ
    expect(regionAny(g, 1, 1, 1)).toBe(true);
    expect(regionAny(g, 1, 0, 1)).toBe(false);
    expect(regionAny(g, 2, 3, 3)).toBe(true);
    expect(regionAny(g, 2, 2, 3)).toBe(false);
    expect(regionAny(g, 3, 7, 7)).toBe(true);
    expect(regionAny(g, 3, 6, 7)).toBe(false);
    expect(regionAny(g, 4, 15, 15)).toBe(false);
  });

  it('飛ばすのは、範囲の区画と周りの区画がすべて不透明なときだけ', () => {
    const full = new Uint8Array(64).fill(1);
    expect(regionSolid(full, 1, 0, 0)).toBe(true);
    expect(regionSolid(full, 2, 1, 2)).toBe(true);
    // 深さ2のタイル (1, 1) は区画 (2..3, 2..3)。周りは (1..4, 1..4)
    const holeNear = full.slice();
    holeNear[4 * 8 + 4] = 0; // 周りの区画が透明
    expect(regionSolid(holeNear, 2, 1, 1)).toBe(false);
    const holeFar = full.slice();
    holeFar[6 * 8 + 6] = 0; // 離れた区画が透明
    expect(regionSolid(holeFar, 2, 1, 1)).toBe(true);
    // 範囲の区画そのものが透明
    const holeIn = full.slice();
    holeIn[2 * 8 + 3] = 0;
    expect(regionSolid(holeIn, 2, 1, 1)).toBe(false);
    // 深さ3（子が4段下になる）は飛ばさない
    expect(regionSolid(full, 3, 0, 0)).toBe(false);
  });
});
