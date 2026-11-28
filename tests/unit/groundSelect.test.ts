/**
 * PlateauGround（標高の起伏を付けた単色の地面）を、偽の renderer と偽の標高の取得で Node 上で確かめる。
 * - 表示中のタイルが範囲と視野を隙間なく・重なりなく覆う。
 * - 取得するのは標高タイルだけで、地面のメッシュの高さは標高に合う。
 * - 海（標高の無効値）だけの範囲には地面を作らない。
 * - 標高タイルを取得できない（回線の失敗）・復号できないときも、祖先の標高（無ければ 0m）の地面が隙間なく表示され、
 *   retryFailedTiles() で取り直すと標高どおりの地面になる。
 */
import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Plane, Ray, Raycaster, Vector3 } from 'three';
import type { WebGLRenderer } from 'three';
import { latLonToLocal, localToLatLon } from '../../src/geo/enu';
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from '../../src/geo/tiles';
import { BASE_LAND_COLOR } from '../../src/scene/plateau/baseGround';
import type { DemTile, FetchPixels } from '../../src/scene/plateau/elevation';
import { PlateauGround, RELIEF_STRENGTH, buildSurface, reliefShade } from '../../src/scene/plateau/ground';
import { TileUnavailableError } from '../../src/scene/plateau/tileFetch';

const W = 800;
const H = 600;
const renderer = {
  getSize: (v: { set(x: number, y: number): unknown }) => v.set(W, H),
  capabilities: { getMaxAnisotropy: () => 8 },
} as unknown as WebGLRenderer;

/** 標高(m)。NaN は無効値（海）。 */
type Height = (lat: number, lon: number) => number;
const FLAT: Height = () => 20;
/** 波打つ起伏（振幅 8m、波長 数百 m）。 */
const HILLS: Height = (lat, lon) => {
  const p = latLonToLocal({ lat, lon });
  return 20 + 8 * Math.sin(p.x / 60) * Math.cos(p.z / 45);
};

interface FakeOptions {
  height?: Height;
  /** 復号に失敗する標高タイル（'kind z/x/y'）。 */
  broken?: Set<string>;
  /** true の間は、すべての標高タイルが取得できない（回線の失敗。再試行の上限に達した扱い）。 */
  network?: { down: boolean };
}

/** 偽の取得。標高は height を国土地理院の符号化（無効値は R=128, G=0, B=0）で返す。取得した URL を記録する。 */
function fakeFetch(opts: FakeOptions = {}): { fetch: FetchPixels; log: string[] } {
  const log: string[] = [];
  const height = opts.height ?? FLAT;
  const fetch: FetchPixels = async (url) => {
    await Promise.resolve();
    const m = /\/(dem5a_png|dem_png)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
    log.push(url);
    if (!m) throw new Error(`unexpected url ${url}`);
    const kind = m[1] === 'dem5a_png' ? 'dem5a' : 'dem10';
    const [z, x, y] = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (opts.network?.down) throw new TileUnavailableError(url);
    if (opts.broken?.has(`${kind} ${z}/${x}/${y}`)) throw new Error('broken');
    const bitmap = { width: 256, height: 256, close: () => undefined } as unknown as ImageBitmap;
    const pixels = new Uint8ClampedArray(256 * 256 * 4);
    for (let j = 0; j < 256; j++) {
      const lat = tileYToLat(y + (j + 0.5) / 256, z);
      for (let i = 0; i < 256; i++) {
        const h = height(lat, tileXToLon(x + (i + 0.5) / 256, z));
        const k = (j * 256 + i) * 4;
        if (Number.isNaN(h)) {
          pixels[k] = 128;
        } else {
          const v = Math.round(h * 100);
          pixels[k] = (v >> 16) & 255;
          pixels[k + 1] = (v >> 8) & 255;
          pixels[k + 2] = v & 255;
        }
        pixels[k + 3] = 255;
      }
    }
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
    detailScale: 1.5,
    fetchPixels: fetch,
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 読み込みが落ち着く（needsUpdate が偽のまま 20 フレーム続き、ready が解決する）まで update する。 */
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

describe('PlateauGround（標高の起伏を付けた単色の地面）', () => {
  it('表示中のタイルが範囲と視野を隙間なく・重なりなく覆い、取得するのは標高タイルだけ', async () => {
    const camera = makeCamera(ORIGIN_VIEW.pos, ORIGIN_VIEW.target);
    const { fetch, log } = fakeFetch();
    const g = makeGround(camera, fetch);
    await settle(g);
    const visible = expectCovered(g, camera, 20);
    expect(Math.max(...visible.map((t) => t.z))).toBeGreaterThanOrEqual(16);
    expect(log.length).toBeGreaterThan(0);
    for (const url of log) expect(url).toMatch(/^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/(dem5a_png|dem_png)\//);
    // 5m メッシュはズーム15、10m メッシュはズーム14まで
    for (const url of log) {
      const z = Number(/\/(\d+)\/\d+\/\d+\.png$/.exec(url)![1]);
      expect(url.includes('dem5a_png') ? z === 15 : z <= 14).toBe(true);
    }
    g.dispose();
  });

  it('地面のメッシュの高さが標高に合う（起伏のある場所）', async () => {
    const camera = makeCamera(new Vector3(0, 170, 60), new Vector3(0, 20, 0));
    const g = makeGround(camera, fakeFetch({ height: HILLS }).fetch);
    await settle(g);
    for (const [x, z] of [
      [0, 0],
      [12, -7],
      [-25, 30],
    ] as const) {
      const ll = localToLatLon({ x, y: 0, z });
      expect(Math.abs(meshHeightAt(g, x, z) - HILLS(ll.lat, ll.lon))).toBeLessThan(0.8);
    }
    g.dispose();
  });

  it('海（標高の無効値）だけの範囲にはタイルを作らず、陸の範囲は覆う', async () => {
    // 原点より南は海
    const coast: Height = (lat, lon) => (latLonToLocal({ lat, lon }).z > 300 ? Number.NaN : 5);
    const camera = makeCamera(new Vector3(0, 1500, 1200), new Vector3(0, 0, 300));
    const g = makeGround(camera, fakeFetch({ height: coast }).fetch);
    await settle(g);
    const visible = g.debugTiles().filter((t) => t.visible);
    expect(visible.length).toBeGreaterThan(0);
    const north = (t: Tile): number => latLonToLocal({ lat: tileYToLat(t.y, t.z), lon: tileXToLon(t.x, t.z) }).z;
    // 北端が海岸線より南のタイル（海だけ）は作らない
    for (const t of visible) expect(north(t)).toBeLessThan(300);
    // 陸の地点は覆われている
    const land = localToLatLon({ x: 0, y: 0, z: 0 });
    expect(visible.filter((t) => contains(t, land.lat, land.lon)).length).toBe(1);
    g.dispose();
  });

  it('標高を復号できないタイルは祖先の標高で作り、隙間ができない', async () => {
    const camera = makeCamera(ORIGIN_VIEW.pos, ORIGIN_VIEW.target);
    const ll = localToLatLon({ x: 0, y: 0, z: 0 });
    const key = `dem5a 15/${Math.floor(lonToTileX(ll.lon, 15))}/${Math.floor(latToTileY(ll.lat, 15))}`;
    const g = makeGround(camera, fakeFetch({ broken: new Set([key]) }).fetch);
    await settle(g);
    expectCovered(g, camera, 20);
    // 10m メッシュ（祖先の標高）で作った地面の高さ
    expect(meshHeightAt(g, 0, 0)).toBeCloseTo(20, 1);
    g.dispose();
  });

  it('回線の失敗で標高タイルを取得できなくても、0m の不透明な地面が隙間なく表示され、取り直すと標高どおりになる', async () => {
    const camera = makeCamera(ORIGIN_VIEW.pos, ORIGIN_VIEW.target);
    const network = { down: true };
    const { fetch, log } = fakeFetch({ network });
    const g = makeGround(camera, fetch);
    await settle(g);
    expectCovered(g, camera, 0);
    expect(meshHeightAt(g, 0, 0)).toBeCloseTo(0, 6);
    // 取得できなかったタイルは覚えていて、同じタイルを要求し続けない
    const requests = log.length;
    for (let i = 0; i < 50; i++) {
      g.update();
      await tick();
    }
    expect(log.length).toBe(requests);

    network.down = false;
    g.retryFailedTiles();
    await settle(g);
    const visible = expectCovered(g, camera, 20);
    expect(Math.max(...visible.map((t) => t.z))).toBeGreaterThanOrEqual(16);
    expect(meshHeightAt(g, 0, 0)).toBeCloseTo(20, 1);
    g.dispose();
  });

  it('カメラを動かしてから止めると、読み込みが終わって needsUpdate が偽になり、ready が解決する', async () => {
    const camera = makeCamera(ORIGIN_VIEW.pos, ORIGIN_VIEW.target);
    const g = makeGround(camera, fakeFetch().fetch);
    let resolved = false;
    void g.ready.then(() => (resolved = true));
    for (let i = 0; i < 40; i++) {
      camera.position.x += 5;
      camera.updateMatrixWorld();
      g.update();
      await tick();
      // 動いている間は needsUpdate（止まったら細かいタイルを読む）。最初のフレームは比べる前のフレームがない
      if (i > 0) expect(g.needsUpdate).toBe(true);
    }
    expect(resolved).toBe(false);
    await settle(g);
    await tick();
    expect(g.needsUpdate).toBe(false);
    expect(resolved).toBe(true);
    g.dispose();
  });
});

/** 1 枚の標高タイル（ズーム15、原点を含む）を height から作る。 */
function demTile(height: Height): DemTile {
  const ll = localToLatLon({ x: 0, y: 0, z: 0 });
  const z = 15;
  const x = Math.floor(lonToTileX(ll.lon, z));
  const y = Math.floor(latToTileY(ll.lat, z));
  const heights = new Float32Array(256 * 256);
  for (let j = 0; j < 256; j++) {
    for (let i = 0; i < 256; i++) heights[j * 256 + i] = height(tileYToLat(y + (j + 0.5) / 256, z), tileXToLon(x + (i + 0.5) / 256, z));
  }
  return { kind: 'dem5a', z, x, y, heights };
}

describe('地面のタイルの画像（陸の色と陰影、海は透明）', () => {
  const r0 = (BASE_LAND_COLOR >> 16) & 255;

  it('平らな陸は陸の色のまま不透明、海（無効値）は透明', () => {
    // タイルの東半分が海
    const dem = demTile(() => 12);
    for (let j = 0; j < 256; j++) for (let i = 128; i < 256; i++) dem.heights[j * 256 + i] = Number.NaN;
    const { pixels } = buildSurface(dem.z, dem.x, dem.y, [dem], 16);
    const west = (8 * 16 + 1) * 4;
    const east = (8 * 16 + 14) * 4;
    expect(pixels[west + 3]).toBe(255);
    expect(pixels[west]).toBe(r0);
    expect(pixels[east + 3]).toBe(0);
  });

  it('5m メッシュの縁で 10m メッシュの値に替わっても、その境に陰影の線が出ない', () => {
    // 5m メッシュ（12m で平ら）はタイルの西半分だけ。東半分は 10m メッシュ（13m で平ら）
    const fine = demTile(() => 12);
    for (let j = 0; j < 256; j++) for (let i = 128; i < 256; i++) fine.heights[j * 256 + i] = Number.NaN;
    const coarse: DemTile = { kind: 'dem10', z: 14, x: fine.x >> 1, y: fine.y >> 1, heights: new Float32Array(256 * 256).fill(13) };
    const { pixels } = buildSurface(fine.z, fine.x, fine.y, [fine, coarse], 16);
    for (let i = 0; i < 16; i++) expect(pixels[(8 * 16 + i) * 4]).toBe(r0);
  });

  it('光（西南西の上）に向く斜面は明るく、背く斜面は暗い。差は RELIEF_STRENGTH 以内', () => {
    // 西に向かって下る（東ほど高い）斜面は、西からの光に向く
    const towardLight = reliefShade(0.2, 0);
    const away = reliefShade(-0.2, 0);
    expect(towardLight).toBeGreaterThan(1);
    expect(away).toBeLessThan(1);
    expect(reliefShade(0, 0)).toBeCloseTo(1, 6);
    for (const s of [-5, -1, 1, 5]) {
      expect(reliefShade(s, s)).toBeGreaterThanOrEqual(1 - RELIEF_STRENGTH - 1e-9);
      expect(reliefShade(s, -s)).toBeLessThanOrEqual(1 + RELIEF_STRENGTH + 1e-9);
    }
    // 東へ上る（西を向く）斜面は明るく、西へ上る（東を向く）斜面は暗い
    const lit = demTile((lat, lon) => latLonToLocal({ lat, lon }).x * 0.1);
    const shaded = demTile((lat, lon) => -latLonToLocal({ lat, lon }).x * 0.1);
    const k = (8 * 16 + 8) * 4;
    expect(buildSurface(lit.z, lit.x, lit.y, [lit], 16).pixels[k]!).toBeGreaterThan(r0);
    expect(buildSurface(shaded.z, shaded.x, shaded.y, [shaded], 16).pixels[k]!).toBeLessThan(r0);
  });
});
