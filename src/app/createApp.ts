/**
 * 本編の組み立て: PLATEAU の街並み（PlateauCity）と語り（createStory）と、場面ごとの 3D の中身（SceneModule）。
 *
 * - 語りの地表の高さ `groundY` は国土地理院の標高。起動時に各場面の注視点とカメラの位置の標高タイルを読んでおき、
 *   同期で引く（読み込む前の地点は近くの既知の値）。カメラが地面に潜らないようにするため。
 * - 建物を読む場所は、カメラが向かっている場面の `place` に合わせて切り替える（場面を離れて動き出した時点で
 *   次の場面の場所を読み始める）。自由操作の間は注視点に合わせて動かす。
 * - 描画は必要なフレームだけ行う（カメラが動いた・街並みを読み込み中・中身から要求があった・リサイズした）。
 */
import { localToLatLon, latLonToLocal } from '../geo/enu';
import { createScene, type DepthMode, type SceneContext } from '../scene/createScene';
import { addSiteAttribution } from '../scene/plateau/attribution';
import { loadPlateauCatalog } from '../scene/plateau/catalog';
import { PlateauCity, type PlateauCityStatus } from '../scene/plateau/stage';
import { poseToCameraPosition, keyframeToPose } from '../story/cameraPath';
import { SCRIPT, type ScriptScene } from '../story/content/script';
import { createStory, type Story } from '../story/createStory';
import type { StoryStage, StoryState } from '../story/types';
import { ElevationCache } from './elevationCache';
import { createLoadingIndicator } from './loadingIndicator';
import type { SceneModule, SceneModuleContext, SceneModuleFactory } from './sceneModule';

export interface CreateAppOptions {
  /** canvas を入れる要素。 */
  container: HTMLElement;
  /** 本文カードを入れる要素。 */
  storyRoot: HTMLElement;
  script?: readonly ScriptScene[];
  /** 場面 id ごとの 3D の中身。 */
  modules?: Record<string, SceneModuleFactory>;
  /** 深度バッファの方式。既定 'logarithmic'。 */
  depth?: DepthMode;
  /** 建物の画面上の許容誤差(px)。既定は PlateauCity の既定値。 */
  buildingErrorTarget?: number;
}

export interface AppStatus {
  state: StoryState;
  city: PlateauCityStatus;
  depthMode: string;
  renderCount: number;
  /** カメラが止まってからのフレーム数。 */
  cameraIdleFrames: number;
  modulesReady: boolean;
  free: boolean;
}

/** E2E と確認用の読み取り口。 */
export interface MainDebugApi {
  stageIds(): string[];
  getState(): StoryState;
  scrollYFor(stage: number, progress: number): number;
  holds(): readonly number[];
  /** カメラの注視点（緯度経度と地表からの高さ）。 */
  target(): { lat: number; lon: number; heightAboveGround: number };
  /** カメラの位置（緯度経度と地表からの高さ）。 */
  camera(): { lat: number; lon: number; heightAboveGround: number };
  status(): AppStatus;
  /** 街並みが出そろい、カメラも止まり、中身の初期化も済んだか。 */
  isSettled(): boolean;
  setFreeOrbit(on: boolean): void;
}

declare global {
  interface Window {
    __MAIN__?: MainDebugApi;
  }
}

/** カメラがこのフレーム数止まっていれば「止まった」とみなす。 */
const CAMERA_IDLE_FRAMES = 5;
/** カメラの高さがこれ以下の場面では、カメラの位置の標高も先に読む(m)。 */
const PREFETCH_CAMERA_BELOW_M = 2000;

export interface App {
  ctx: SceneContext;
  city: PlateauCity;
  story: Story;
  modules: SceneModule[];
  debug: MainDebugApi;
  /** 最初のフレームを描画すると解決する。 */
  firstFrame: Promise<void>;
  dispose(): void;
}

export async function createApp(options: CreateAppOptions): Promise<App> {
  const script = options.script ?? SCRIPT;
  const first = script[0];
  if (!first) throw new Error('台本が空です');

  const ctx = createScene(options.container, {
    minimal: false,
    controls: true,
    depth: options.depth ?? 'logarithmic',
    skyColor: 0xbfd9ee,
    altitudeFog: true,
    stableViewport: true,
    fov: 45,
  });
  const { camera, renderer, scene, controls } = ctx;

  const attribution = addSiteAttribution(document.body);
  const indicator = createLoadingIndicator(document.body);
  indicator.set(true);

  const catalog = await loadPlateauCatalog();
  const firstPlace = script.find((s) => s.place)?.place;
  if (!firstPlace) throw new Error('台本に場所がありません');
  const city = new PlateauCity({ scene, camera, renderer, catalog, focus: firstPlace, errorTarget: options.buildingErrorTarget });
  const elevation = new ElevationCache(city.ground.elevation);

  // 場面の注視点と（低い場面は）カメラの位置の標高を先に読む。キーフレームはこの標高で決まる。
  await Promise.all(
    script.flatMap((s) => {
      const jobs = [elevation.prefetch(s.camera.target.lat, s.camera.target.lon)];
      const pose = keyframeToPose(s.camera, () => 0);
      const cam = poseToCameraPosition(pose);
      if (cam.y < PREFETCH_CAMERA_BELOW_M) {
        const ll = localToLatLon({ x: cam.x, y: 0, z: cam.z });
        jobs.push(elevation.prefetch(ll.lat, ll.lon));
      }
      return jobs;
    }),
  );
  const groundY = (lat: number, lon: number): number => elevation.heightAt(lat, lon);

  let renderRequested = true;
  const requestRender = (): void => {
    renderRequested = true;
  };
  ctx.onResize(requestRender);

  // 場面ごとの中身
  const factories = options.modules ?? {};
  const modules: (SceneModule | null)[] = script.map((s) => factories[s.id]?.() ?? null);
  let storyRef: Story | null = null;
  const moduleCtx = (index: number): SceneModuleContext => ({
    scene,
    camera,
    renderer,
    toLocal: (lat, lon, altM = 0) => latLonToLocal({ lat, lon, alt: altM }),
    toLatLon: (x, z) => {
      const p = localToLatLon({ x, y: 0, z });
      return { lat: p.lat, lon: p.lon };
    },
    elevationAt: (lat, lon) => elevation.prefetch(lat, lon),
    groundHeight: groundY,
    requestRender,
    holdOf: () => storyRef?.scroll.getHolds()[index] ?? 0.4,
  });

  const lastProgress = script.map(() => 0);
  const stages: StoryStage[] = script.map((s, i) => ({
    id: s.id,
    text: s.text,
    camera: s.camera,
    freeOrbit: s.freeOrbit,
    onProgress: (p) => {
      lastProgress[i] = p;
      modules[i]?.setProgress(p);
    },
  }));

  const story = createStory({ scene: ctx, stages, root: options.storyRoot, groundY });
  storyRef = story;

  let activeIndex = -1;
  const unsubscribe = story.scroll.subscribe((state) => {
    if (state.stage === activeIndex) return;
    modules[activeIndex]?.setActive(false);
    activeIndex = state.stage;
    modules[activeIndex]?.setActive(true);
    requestRender();
  });

  let modulesReady = false;
  const modulesInit = Promise.all(
    modules.map(async (m, i) => {
      if (!m) return;
      await m.init(moduleCtx(i));
      m.setProgress(lastProgress[i] ?? 0);
      m.setActive(i === activeIndex);
    }),
  ).then(() => {
    modulesReady = true;
    requestRender();
  });
  modulesInit.catch((err: unknown) => console.warn('場面の中身の初期化に失敗しました', err));

  // 建物を読む場所。カメラが向かっている場面の place。
  function updateFocus(): void {
    if (story.rig.isFree) {
      const place = script[activeIndex]?.place;
      if (!place) return;
      const t = controls.target;
      const f = city.focus;
      const c = latLonToLocal({ lat: f.lat, lon: f.lon });
      if (Math.hypot(t.x - c.x, t.z - c.z) > place.radiusM * 0.25) {
        const ll = localToLatLon({ x: t.x, y: 0, z: t.z });
        city.setFocus({ ...place, lat: ll.lat, lon: ll.lon });
      }
      return;
    }
    const { stage, progress } = story.scroll.getState();
    const hold = story.scroll.getHolds()[stage] ?? 0.4;
    const heading = progress > hold && stage + 1 < script.length ? stage + 1 : stage;
    const place = script[heading]?.place;
    if (place) city.setFocus(place);
  }

  let renderCount = 0;
  let cameraIdleFrames = 0;
  let last = performance.now();
  let resolveFirst!: () => void;
  const firstFrame = new Promise<void>((r) => (resolveFirst = r));

  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - last) / 1000, 1);
    last = now;
    updateFocus();
    const moved = story.update(dt);
    cameraIdleFrames = moved ? 0 : cameraIdleFrames + 1;
    let needed = moved || renderRequested;
    for (const m of modules) if (m?.update?.(dt)) needed = true;
    renderRequested = false;
    if (needed || city.busy) {
      city.update();
      ctx.render();
      renderCount++;
      if (renderCount === 1) resolveFirst();
    }
    const st = city.status();
    indicator.set(st.groundLoading || st.buildingsLoading, st.buildingsLoading ? '建物' : st.groundLoading ? '地面' : undefined);
  });

  story.scroll.refresh();

  const heightAt = (x: number, y: number, z: number): { lat: number; lon: number; heightAboveGround: number } => {
    const ll = localToLatLon({ x, y: 0, z });
    return { lat: ll.lat, lon: ll.lon, heightAboveGround: y - groundY(ll.lat, ll.lon) };
  };

  const debug: MainDebugApi = {
    stageIds: () => script.map((s) => s.id),
    getState: () => story.scroll.getState(),
    scrollYFor: (stage, progress) => story.scroll.scrollYFor(stage, progress),
    holds: () => story.scroll.getHolds(),
    target: () => heightAt(controls.target.x, controls.target.y, controls.target.z),
    camera: () => heightAt(camera.position.x, camera.position.y, camera.position.z),
    status: () => ({
      state: story.scroll.getState(),
      city: city.status(),
      depthMode: ctx.depthMode,
      renderCount,
      cameraIdleFrames,
      modulesReady,
      free: story.rig.isFree,
    }),
    isSettled: () => modulesReady && cameraIdleFrames >= CAMERA_IDLE_FRAMES && !city.busy,
    setFreeOrbit: (on) => story.setFreeOrbit(on),
  };

  return {
    ctx,
    city,
    story,
    modules: modules.filter((m): m is SceneModule => m !== null),
    debug,
    firstFrame,
    dispose() {
      renderer.setAnimationLoop(null);
      unsubscribe();
      for (const m of modules) m?.dispose();
      story.dispose();
      city.dispose();
      indicator.dispose();
      attribution.remove();
      ctx.dispose();
    },
  };
}
