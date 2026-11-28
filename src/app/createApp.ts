/**
 * 本編の組み立て: PLATEAU の街並み（PlateauCity）と語り（createStory）と、場面ごとの 3D の中身（SceneModule）。
 *
 * - 語りの地表の高さ `groundY` は国土地理院の標高。起動時に各場面の注視点とカメラの位置の標高タイルを読んでおき、
 *   同期で引く（読み込む前の地点は近くの既知の値）。カメラが地面に潜らないようにするため。
 * - 建物は既定で変換済みのデータ（`public/data/buildings/`）を読み、カメラと注視点の位置に応じて必要なチャンクだけを読む。
 *   URL に `?buildings=live` を付けると、PLATEAU の配信サーバーから直接読む（見え方の比較用）。
 * - 直接読むときの建物を読む場所は、カメラが向かっている場面の `place` に合わせて切り替える（場面を離れて動き出した時点で
 *   次の場面の場所を読み始める）。自由操作の間は注視点に合わせて動かす。
 * - 描画は必要なフレームだけ行う（カメラが動いた・街並みを読み込み中・中身から要求があった・リサイズした）。
 * - `pauseWhenCovered` の要素（「データと方法」の節）が画面を覆っている間は、3D の画面が見えないので、描画のループを止める。
 * - 街の上の地名（`placeLabelsLayer.ts`）は、毎フレーム、場面の中身を進めた後に置き直す（駅のラベルと主役を避けるため）。
 */
import { localToLatLon, latLonToLocal } from '../geo/enu';
import { createScene, type DepthMode, type SceneContext } from '../scene/createScene';
import { addSiteAttribution } from '../scene/plateau/attribution';
import { loadPlateauCatalog } from '../scene/plateau/catalog';
import { buildingSourceFromUrl } from '../scene/plateau/bakedBuildings';
import { PlateauCity, type PlateauCityStatus } from '../scene/plateau/stage';
import { poseToCameraPosition, keyframeToPose, viewsOf } from '../story/cameraPath';
import { SCRIPT, type ScriptScene } from '../story/content/script';
import { createStory, type Story } from '../story/createStory';
import type { StoryCameraKeyframe, StoryStage, StoryState } from '../story/types';
import { Vector3, type Object3D } from 'three';
import { ElevationCache } from './elevationCache';
import { createLoadingIndicator } from './loadingIndicator';
import { watchCover } from './methods/coverWatch';
import type { SceneModule, SceneModuleContext, SceneModuleFactory } from './sceneModule';
import { PlaceLabelsLayer } from './placeLabelsLayer';
import { measureBuildingShare, measureVisibility, type CoverRect, type VisibilityResult } from './visibility';

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
  /** 建物の画面上の許容誤差(px)。直接読むとき（'live'）だけ。既定は PlateauCity の既定値。 */
  buildingErrorTarget?: number;
  /** 建物の読み方。既定は URL の `?buildings=live` があれば 'live'、なければ 'baked'（変換済みのデータ）。 */
  buildings?: 'baked' | 'live';
  /** 画面の上端に達して画面を覆っている間は、描画のループを止める要素（不透明で、画面より背が高い節）。 */
  pauseWhenCovered?: HTMLElement;
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
  /** 注視点の画面上の位置（canvas の左上を原点とする CSS px）。 */
  targetOnScreen(): { x: number; y: number };
  status(): AppStatus;
  /** 街並みが出そろい、カメラも止まり、中身の初期化も済んだか。 */
  isSettled(): boolean;
  setFreeOrbit(on: boolean): void;
  /**
   * いまの場面の主役（自転車・山）が、建物に隠れずに・本文カードと出典表示に覆われずに見えている割合（`visibility.ts`）。
   * 主役のない場面では null。buildings=true なら建物の画面の占有率も測る。
   */
  measureVisibility(options?: { expand?: number; buildings?: boolean }): (VisibilityResult & { covers: CoverRect[] }) | null;
  /** 建物の画面の占有率（いまのカメラ）。 */
  buildingShare(): number;
  /** 緯度経度・標高(m)の点の画面上の位置（canvas の左上を原点とする CSS px）。inFront はカメラの前にあるか。 */
  project(lat: number, lon: number, altM: number): { x: number; y: number; inFront: boolean };
  /** 本文カードと出典表示など、画面を覆う DOM の長方形（canvas の左上を原点とする CSS px）。 */
  covers(): CoverRect[];
  /** 場面 index のカメラを差し替える（null で台本に戻す）。カメラ位置の候補を試す確認用。 */
  setStageCamera(index: number, keyframe: StoryCameraKeyframe | null): void;
  /**
   * 連続位置 position（`StoryState.position`）で、スクロールが止まったときの語りのカメラ。ローカル座標（m）と、
   * カメラの真下の地表からの高さ。場面の間の移動の経路を調べるのに使う。
   */
  poseAt(position: number): { camera: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; heightAboveGround: number };
  /** 縦長の画面用のカメラを使っているか。 */
  portrait(): boolean;
  /** 地点の標高(m)（国土地理院の標高タイル。読み込み済みの範囲は正確な値）。 */
  groundHeight(lat: number, lon: number): number;
  /** いまのカメラの方位・仰角（俯角）・注視点までの距離。 */
  pose(): { azimuthDeg: number; elevationDeg: number; distance: number };
  /**
   * 確認用: 1 フレームで進める時間の上限(s)を変える（既定 1）。描画の遅い環境でも、追従の途中のカメラを細かく刻める。
   */
  setMaxFrameDt(sec: number): void;
  /** 確認用: フレームごとのカメラの位置（ローカル座標）の記録を始める（true）・やめて記録を返す（false）。 */
  traceCamera(on: boolean): { x: number; y: number; z: number }[];
}

declare global {
  interface Window {
    __MAIN__?: MainDebugApi;
  }
}

/** カメラがこのフレーム数止まっていれば「止まった」とみなす。 */
const CAMERA_IDLE_FRAMES = 5;
/** 場面の間を移る途中のカメラの高さの下限の上限(m)（`transitionFloor`）。丸の内・新宿の高層ビル（200m 前後）の上を通る。 */
const TRANSITION_CLEARANCE_M = 200;
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

  const buildings = options.buildings ?? buildingSourceFromUrl();
  const catalog = buildings === 'live' ? await loadPlateauCatalog() : undefined;
  const firstPlace = script.find((s) => s.place)?.place;
  if (!firstPlace) throw new Error('台本に場所がありません');
  const city = new PlateauCity({
    scene,
    camera,
    renderer,
    catalog,
    buildings,
    lookAt: () => controls.target,
    focus: firstPlace,
    errorTarget: options.buildingErrorTarget,
  });
  const elevation = new ElevationCache(city.ground.elevation);

  // 場面の注視点と（低い場面は）カメラの位置の標高を先に読む。キーフレームはこの標高で決まる。
  await Promise.all(
    script.flatMap((s) =>
      viewsOf(s.camera).flatMap((view) => {
        const jobs = [elevation.prefetch(view.target.lat, view.target.lon)];
        const pose = keyframeToPose(view, () => 0);
        const cam = poseToCameraPosition(pose);
        if (cam.y < PREFETCH_CAMERA_BELOW_M) {
          const ll = localToLatLon({ x: cam.x, y: 0, z: cam.z });
          jobs.push(elevation.prefetch(ll.lat, ll.lon));
        }
        return jobs;
      }),
    ),
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

  // 場面の間を移る途中は、両端のカメラの高さ（地表から、200m まで）より下がらない（建物の中を通り抜けない）
  const story = createStory({ scene: ctx, stages, root: options.storyRoot, groundY, rig: { transitionClearance: TRANSITION_CLEARANCE_M } });
  storyRef = story;

  // 街の上の地名（場面ごとの一覧から、カメラの高さと画面の空きに合わせて出す）
  const placeLabels = new PlaceLabelsLayer({
    container: options.container,
    script,
    story,
    camera,
    modules,
    target: () => controls.target,
    groundHeight: groundY,
  });

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

  /** 1 フレームで進める時間の上限(s)。確認用に小さくすると、描画の遅い環境でもカメラの動きを細かく刻める。 */
  let maxFrameDt = 1;
  /** 確認用: フレームごとのカメラの位置の記録（null は記録しない）。 */
  let trace: { x: number; y: number; z: number }[] | null = null;
  let renderCount = 0;
  let cameraIdleFrames = 0;
  let last = performance.now();
  let resolveFirst!: () => void;
  const firstFrame = new Promise<void>((r) => (resolveFirst = r));

  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, maxFrameDt);
    last = now;
    updateFocus();
    const moved = story.update(dt);
    if (trace) trace.push({ x: camera.position.x, y: camera.position.y, z: camera.position.z });
    cameraIdleFrames = moved ? 0 : cameraIdleFrames + 1;
    let needed = moved || renderRequested;
    for (const m of modules) if (m?.update?.(dt)) needed = true;
    placeLabels.update();
    renderRequested = false;
    if (needed || city.busy) {
      city.update();
      ctx.render();
      renderCount++;
      if (renderCount === 1) {
        resolveFirst();
        applyCover();
      }
    }
    const st = city.status();
    indicator.set(st.groundLoading || st.buildingsLoading, st.buildingsLoading ? '建物' : st.groundLoading ? '地面' : undefined);
  };
  renderer.setAnimationLoop(frame);

  // 節が画面を覆っている間は、描画のループを止める。戻ったら、経過時間を数え直して再開し、すぐに1フレーム描く。
  // 最初のフレームは、覆われた状態で開いたときも描く（__APP_READY__ とスクロールの位置の計算のため）。
  let covered = false;
  let loopPaused = false;
  const applyCover = (): void => {
    if (covered && renderCount > 0) {
      if (loopPaused) return;
      loopPaused = true;
      document.documentElement.classList.add('ptm-in-methods');
      renderer.setAnimationLoop(null);
      indicator.set(false);
    } else if (loopPaused) {
      loopPaused = false;
      document.documentElement.classList.remove('ptm-in-methods');
      last = performance.now();
      renderRequested = true;
      renderer.setAnimationLoop(frame);
    }
  };
  const stopCoverWatch = options.pauseWhenCovered
    ? watchCover(options.pauseWhenCovered, (c) => {
        covered = c;
        applyCover();
      })
    : null;

  story.scroll.refresh();

  const heightAt = (x: number, y: number, z: number): { lat: number; lon: number; heightAboveGround: number } => {
    const ll = localToLatLon({ x, y: 0, z });
    return { lat: ll.lat, lon: ll.lon, heightAboveGround: y - groundY(ll.lat, ll.lon) };
  };

  const canvasEl = renderer.domElement;
  const covers = (): CoverRect[] => {
    const base = canvasEl.getBoundingClientRect();
    const out: CoverRect[] = [];
    const add = (el: Element): void => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom <= base.top || r.top >= base.bottom) return;
      out.push({ left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top });
    };
    for (const c of document.querySelectorAll<HTMLElement>('.story-card')) {
      if (Number(getComputedStyle(c).opacity) > 0.05) add(c);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.ptm-cover__panel')) {
      if (Number(getComputedStyle(el).opacity) > 0.05) add(el);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.ptm-site-attribution, .story-free-toggle')) {
      if (!el.hidden && getComputedStyle(el).display !== 'none') add(el);
    }
    return out;
  };
  const buildingObjects = (): Object3D[] =>
    scene.children.filter((o) => o.name === 'plateau-baked-buildings' || o.name.startsWith('plateau-buildings'));
  /** 航空写真の下に敷く単色の地面（測るときに遮るものとして描かない。`visibility.ts` の `exclude`）。 */
  const notOccluders = (): Object3D[] => scene.children.filter((o) => o.name === 'plateau-base-ground');
  const canvasSize = (): { width: number; height: number } => ({ width: canvasEl.clientWidth, height: canvasEl.clientHeight });

  const debug: MainDebugApi = {
    stageIds: () => script.map((s) => s.id),
    getState: () => story.scroll.getState(),
    scrollYFor: (stage, progress) => story.scroll.scrollYFor(stage, progress),
    holds: () => story.scroll.getHolds(),
    target: () => heightAt(controls.target.x, controls.target.y, controls.target.z),
    camera: () => heightAt(camera.position.x, camera.position.y, camera.position.z),
    targetOnScreen: () => {
      camera.updateMatrixWorld();
      const v = controls.target.clone().project(camera);
      const canvas = renderer.domElement;
      return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
    },
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
    measureVisibility: (opts = {}) => {
      const targets = modules[activeIndex]?.measureTargets?.() ?? null;
      if (!targets) return null;
      const cv = covers();
      // 霧はカメラの高さで変わるので、いまのフレームと同じ値にしてから測る
      camera.updateMatrixWorld();
      const r = measureVisibility(renderer, scene, camera, targets, canvasSize(), {
        expand: opts.expand,
        covers: cv,
        buildings: opts.buildings ? buildingObjects() : undefined,
        exclude: notOccluders(),
        ground: scene.children.filter((o) => o.name === 'plateau-ground'),
      });
      requestRender();
      return { ...r, covers: cv };
    },
    buildingShare: () => {
      camera.updateMatrixWorld();
      const v = measureBuildingShare(renderer, scene, camera, buildingObjects(), canvasSize(), notOccluders());
      requestRender();
      return v;
    },
    project: (lat, lon, altM) => {
      camera.updateMatrixWorld();
      const p = latLonToLocal({ lat, lon, alt: altM });
      const v = new Vector3(p.x, p.y, p.z);
      const inFront = v.clone().applyMatrix4(camera.matrixWorldInverse).z < 0;
      v.project(camera);
      return { x: ((v.x + 1) / 2) * canvasEl.clientWidth, y: ((1 - v.y) / 2) * canvasEl.clientHeight, inFront };
    },
    covers,
    setStageCamera: (index, keyframe) => {
      story.rig.setStageCamera(index, keyframe);
      requestRender();
    },
    poseAt: (position) => {
      const pose = story.rig.poseAt(position);
      const cam = poseToCameraPosition(pose);
      return { camera: cam, target: { ...pose.target }, heightAboveGround: heightAt(cam.x, cam.y, cam.z).heightAboveGround };
    },
    portrait: () => story.rig.portrait,
    groundHeight: (lat, lon) => groundY(lat, lon),
    pose: () => {
      const p = story.rig.getPose();
      return { azimuthDeg: p.azimuthDeg, elevationDeg: p.elevationDeg, distance: p.distance };
    },
    setMaxFrameDt: (sec) => {
      maxFrameDt = Math.max(1e-3, sec);
    },
    traceCamera: (on) => {
      const out = trace ?? [];
      trace = on ? [] : null;
      return out;
    },
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
      stopCoverWatch?.();
      document.documentElement.classList.remove('ptm-in-methods');
      unsubscribe();
      for (const m of modules) m?.dispose();
      placeLabels.dispose();
      story.dispose();
      city.dispose();
      indicator.dispose();
      attribution.remove();
      ctx.dispose();
    },
  };
}
