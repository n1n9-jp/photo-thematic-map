/**
 * 主役（自転車・自転車の山）が「建物に隠れずに画面に見えている割合」を、画面外の描画先へ描いて画素を数えて測る。
 *
 * 変換済みの建物は GPU へ送ったあと CPU 側の頂点を解放しているので、レイキャストではなく描画で測る。
 * 主役の材質（自転車は頂点シェーダーで位置を決める）も建物の材質もそのまま使い、差し替えない。
 *
 * 1. 主役だけ（広げた視野）: いまの投影の幅と高さを `expand` 倍に広げた視野（中央の 1/expand がいまの画面とちょうど重なる）で、
 *    地面を深度だけ描いてから（`ground`。地面に埋まった部分を数えない）、主役だけを描く。描かれた画素の数が「主役の全体」（画面の外に出ている分を含む）。中央の部分が「画面に入っている分」。
 * 2. 建物と地面を手前に置いて主役: いまの画面を `pixelScale` 倍の細かさで、主役以外（建物・地面）を深度だけ描き（色は書かない）、
 *    続けて主役を描く。深度の試験に通った画素の、主役だけを描いた画素に対する割合が「隠れていない割合」。
 *    これを 1. の画面に入っている分に掛けたものが「見えている分」。
 * 3. そのうち、本文カードと出典表示（DOM の長方形 `covers`）の外にある画素が「隠れずに見えている分」。
 *
 * 描画先の背景は透明（アルファ 0）にし、主役の画素はアルファ 1 で描かれるので、アルファで数える。
 * 画素の大きさは CSS px（devicePixelRatio に依らない）。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Points,
  PointsMaterial,
  Vector3,
  PerspectiveCamera,
  RGBAFormat,
  UnsignedByteType,
  WebGLRenderTarget,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';

/** 測る対象（場面のモジュールが返す）。 */
export interface MeasureTargets {
  /** 主役のオブジェクト（自転車の群れ、山）。 */
  subjects: Object3D[];
  /** 測るときに描かないオブジェクト（足元の印など、主役でも遮るものでもない補助の表示）。 */
  hide?: Object3D[];
  /**
   * 描く前に、カメラに合わせた詳細度・視錐台の判定をし直す（自転車は視錐台の外を描かないので、広げた視野でも呼ぶ）。
   * viewportHeightPx は描画先の高さ(CSS px)。
   */
  prepare?(camera: PerspectiveCamera, viewportHeightPx: number): void;
  /**
   * 主役が数えられる物（462台の自転車）なら、1台ごとの標本点（ローカル座標 x, y, z を perItem 点ずつ）。
   * 遠くから見下ろすと自転車は 1 台 1 画素に満たず、画素の比はカメラのわずかな違いで揺れるので、
   * 「何台が見えているか」を標本点で数える（`VisibilityResult.items`）。
   */
  samples?: { points: Float32Array; perItem: number };
}

/** 画面（canvas）の左上を原点とする長方形(CSS px)。 */
export interface CoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface VisibilityOptions {
  /** 画面の外の分を数えるために広げる倍率（幅・高さ）。既定 3。 */
  expand?: number;
  /**
   * 隠れている割合を測る段（いまの画面）の細かさ（CSS px あたりの画素の数、縦横それぞれ）。既定 2。
   * 画面に入っている割合（広げた視野）は 1 で測る。
   */
  pixelScale?: number;
  /** 本文カードなど、画面を覆う DOM の長方形(CSS px)。 */
  covers?: readonly CoverRect[];
  /** 建物の画面の占有率も測るときの、建物のオブジェクト（地面は深度だけ描き、建物を描いた画素を数える）。 */
  buildings?: Object3D[];
  /**
   * 地面（航空写真の地面）。主役の全体を数える段（広げた視野）でも深度だけ先に描き、地面より下に埋まっている部分
   * （山の裾が地面に沈んでいる分、車輪の接地面など）を主役の画素に数えない。こうすると、割合は「建物に隠れていない割合」になる。
   */
  ground?: Object3D[];
  /**
   * 遮るものとして描かないオブジェクト。航空写真の下に敷く単色の地面（数百 km の三角形 2 枚）は、ソフトウェア描画（SwiftShader）で
   * 描画先へ深度を書くと手前の深度になることがあり、航空写真の地面より下にあって何も隠さないので、ここに渡して除く。
   */
  exclude?: Object3D[];
}

export interface VisibilityResult {
  width: number;
  height: number;
  expand: number;
  /** 主役の全体の画素数（広げた視野。画面の外の分を含む）。 */
  subjectPixels: number;
  /** そのうち画面に入っている画素数。 */
  onScreenPixels: number;
  /** 主役だけをいまの画面で（pixelScale 倍の細かさで）描いた画素数を CSS px に直した値（onScreenPixels とほぼ同じになる。確かめ用）。 */
  soloPixels: number;
  /**
   * 画面に入っていて、建物に隠れていない画素数（onScreenPixels × 細かく描いて求めた隠れていない割合）。
   * 地面に埋まった部分は、はじめから主役の画素に数えない（`ground`）。
   */
  unoccludedPixels: number;
  /** さらに本文カード・出典表示にも覆われていない画素数。 */
  clearPixels: number;
  /** onScreenPixels / subjectPixels。 */
  onScreen: number;
  /** unoccludedPixels / subjectPixels（画面の外の分も「見えていない」に数える）。 */
  unoccluded: number;
  /** clearPixels / subjectPixels。 */
  clear: number;
  /** 画面に入っている分のうち、建物か地面に隠れている割合（1 − unoccludedPixels / onScreenPixels）。 */
  occludedOnScreen: number;
  /** 画面に入っている主役の画素を囲む長方形(CSS px)。なければ null。 */
  bbox: CoverRect | null;
  /** 見えている主役の画素（clear）が画面に占める割合。 */
  screenShare: number;
  /** 建物を描いた画素が画面に占める割合（`buildings` を渡したときだけ）。 */
  buildingShare: number | null;
  /**
   * 1台ごとの数え方（`MeasureTargets.samples` があるときだけ）。標本点のうち過半が画面に入り建物にも地面にも
   * 隠れていない物を「見えている」、さらにその標本点の過半が本文カードにも覆われていない物を「隠れずに見えている」とする。
   */
  items: VisibilityItems | null;
}

/** 1台ごとの数え方の結果。 */
export interface VisibilityItems {
  total: number;
  /** 標本点の過半が画面に入り、建物にも地面にも隠れていない台数。 */
  visible: number;
  /** さらに本文カード・出典表示にも覆われていない台数。 */
  clear: number;
  visibleFraction: number;
  clearFraction: number;
  /** 建物に隠れているかに関わらず、標本点の過半が画面に入り、本文カード・出典表示に覆われていない台数（収まっているか）。 */
  framed: number;
  framedFraction: number;
  /** 画面に入っている標本点を囲む長方形(CSS px)。なければ null。 */
  bbox: CoverRect | null;
}

interface SavedState {
  visible: Map<Object3D, boolean>;
  background: Scene['background'];
  autoClear: boolean;
  clearColor: Color;
  clearAlpha: number;
  target: ReturnType<WebGLRenderer['getRenderTarget']>;
}

function save(renderer: WebGLRenderer, scene: Scene): SavedState {
  const visible = new Map<Object3D, boolean>();
  scene.traverse((o) => visible.set(o, o.visible));
  return {
    visible,
    background: scene.background,
    autoClear: renderer.autoClear,
    clearColor: renderer.getClearColor(new Color()),
    clearAlpha: renderer.getClearAlpha(),
    target: renderer.getRenderTarget(),
  };
}

function restore(renderer: WebGLRenderer, scene: Scene, s: SavedState): void {
  for (const [o, v] of s.visible) o.visible = v;
  scene.background = s.background;
  renderer.autoClear = s.autoClear;
  renderer.setClearColor(s.clearColor, s.clearAlpha);
  renderer.setRenderTarget(s.target);
}

/**
 * keep に含まれるオブジェクト（とその子孫・祖先）だけを、元の表示状態のまま見せる。ほかは隠す。
 * 元の状態は saved から読む（前の段で隠したものに左右されない）。
 */
function showOnly(saved: SavedState, keep: readonly Object3D[], hide: readonly Object3D[] = []): void {
  const keepSet = new Set<Object3D>();
  for (const k of keep) {
    k.traverse((o) => keepSet.add(o));
    let p = k.parent;
    while (p) {
      keepSet.add(p);
      p = p.parent;
    }
  }
  for (const [o, v] of saved.visible) o.visible = keepSet.has(o) ? v : false;
  for (const h of hide) h.visible = false;
}

/** 半透明の材質（透明度 0 で隠している柱なども含む）か、色を書かない材質だけのオブジェクトか。 */
function isSeeThrough(o: Object3D): boolean {
  const m = (o as Object3D & { material?: Material | Material[] }).material;
  if (!m) return false;
  const list = Array.isArray(m) ? m : [m];
  return list.length > 0 && list.every((x) => x.transparent || !x.depthWrite || !x.colorWrite || x.opacity <= 0);
}

/**
 * 遮るもの（except 以外）を元の表示状態にし、except を隠す。半透明のもの（透明度 0 で隠している柱など）は、普通の描画では
 * 不透明なものの後に描かれて主役を隠さないので、深度だけを描く段でも描かない。
 */
function showExcept(saved: SavedState, except: readonly Object3D[]): void {
  for (const [o, v] of saved.visible) o.visible = v && !isSeeThrough(o);
  for (const e of except) e.visible = false;
}

function readAlpha(renderer: WebGLRenderer, rt: WebGLRenderTarget, w: number, h: number): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  return buf;
}

/** いまの投影の幅・高さを k 倍に広げたカメラ（中央の 1/k がいまの画面と重なる）。 */
function expandedCamera(camera: PerspectiveCamera, k: number): PerspectiveCamera {
  const ex = camera.clone();
  ex.fov = (2 * Math.atan(k * Math.tan((camera.fov * Math.PI) / 360)) * 180) / Math.PI;
  camera.updateMatrixWorld();
  ex.matrixWorld.copy(camera.matrixWorld);
  ex.matrixWorldInverse.copy(camera.matrixWorldInverse);
  ex.matrixAutoUpdate = false;
  ex.matrixWorldAutoUpdate = false;
  const s = new Matrix4().makeScale(1 / k, 1 / k, 1);
  ex.projectionMatrix.multiplyMatrices(s, camera.projectionMatrix);
  ex.projectionMatrixInverse.copy(ex.projectionMatrix).invert();
  // updateProjectionMatrix を呼ぶと上書きされるので、呼ばれないように投影の拡大は直接持たせたまま使う
  return ex;
}

/**
 * 主役の見えている割合を測る。width・height は画面（canvas）の大きさ(CSS px)。
 * 測ったあとは、表示状態・背景・描画先・主役の詳細度をすべて元に戻す（呼び出し側は次のフレームを普通に描けばよい）。
 */
export function measureVisibility(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  targets: MeasureTargets,
  size: { width: number; height: number },
  options: VisibilityOptions = {},
): VisibilityResult {
  const W = Math.max(1, Math.round(size.width));
  const H = Math.max(1, Math.round(size.height));
  // 中央の 1/k がちょうど画素の境目に重なるよう、奇数にする
  const k = 2 * Math.floor(Math.max(1, options.expand ?? 3) / 2) + 1;
  const covers = options.covers ?? [];
  const saved = save(renderer, scene);
  const rtEx = new WebGLRenderTarget(W * k, H * k, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: true });
  const sc = Math.max(1, Math.round(options.pixelScale ?? 2));
  const Ws = W * sc;
  const Hs = H * sc;
  const rt = new WebGLRenderTarget(Ws, Hs, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: true });
  const color = renderer.state.buffers.color;
  /** 地面を深度だけ描く（いまの描画先へ）。 */
  const groundDepth = (cam: PerspectiveCamera): void => {
    if (!options.ground || options.ground.length === 0) return;
    showOnly(saved, options.ground);
    color.setMask(false);
    color.setLocked(true);
    renderer.render(scene, cam);
    color.setLocked(false);
    color.setMask(true);
  };
  try {
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;

    // 1. 主役だけ（広げた視野）
    const ex = expandedCamera(camera, k);
    targets.prepare?.(ex, H * k);
    renderer.setRenderTarget(rtEx);
    renderer.clear(true, true, true);
    groundDepth(ex);
    showOnly(saved, targets.subjects, targets.hide);
    renderer.render(scene, ex);
    const a = readAlpha(renderer, rtEx, W * k, H * k);
    let subjectPixels = 0;
    let onScreenPixels = 0;
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    const W3 = W * k;
    for (let row = 0; row < H * k; row++) {
      const inRow = row >= H * ((k - 1) / 2) && row < H * ((k + 1) / 2);
      for (let col = 0; col < W3; col++) {
        if (a[(row * W3 + col) * 4 + 3]! === 0) continue;
        subjectPixels++;
        if (inRow && col >= W * ((k - 1) / 2) && col < W * ((k + 1) / 2)) {
          onScreenPixels++;
          const x = col - W * ((k - 1) / 2);
          const y = H - 1 - (row - H * ((k - 1) / 2));
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
    }

    // 2. いまの画面を pixelScale 倍の細かさで: 主役だけ（地面は深度だけ）と、建物と地面を深度だけ描いてから主役
    //    （自転車は数画素の細い形なので、細かく描いて隠れている割合のばらつきを抑える）
    targets.prepare?.(camera, H);
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    groundDepth(camera);
    showOnly(saved, targets.subjects, targets.hide);
    renderer.render(scene, camera);
    const solo = readAlpha(renderer, rt, Ws, Hs);
    let soloS = 0;
    for (let i = 3; i < solo.length; i += 4) if (solo[i]! > 0) soloS++;
    renderer.clear(true, true, true);
    showExcept(saved, [...targets.subjects, ...(targets.hide ?? []), ...(options.exclude ?? [])]);
    color.setMask(false);
    color.setLocked(true);
    renderer.render(scene, camera);
    color.setLocked(false);
    color.setMask(true);
    showOnly(saved, targets.subjects, targets.hide);
    renderer.render(scene, camera);
    const b = readAlpha(renderer, rt, Ws, Hs);
    let unoccS = 0;
    let clearS = 0;
    for (let row = 0; row < Hs; row++) {
      const y = (Hs - 1 - row + 0.5) / sc;
      for (let col = 0; col < Ws; col++) {
        if (b[(row * Ws + col) * 4 + 3]! === 0) continue;
        unoccS++;
        const x = (col + 0.5) / sc;
        let covered = false;
        for (const c of covers) {
          if (x >= c.left && x < c.right && y >= c.top && y < c.bottom) {
            covered = true;
            break;
          }
        }
        if (!covered) clearS++;
      }
    }
    // 画面に入っている分（広げた視野の中央）に、細かく描いて求めた「隠れていない割合」を掛ける
    const soloPixels = soloS / (sc * sc);
    const unoccludedPixels = soloS > 0 ? (onScreenPixels * unoccS) / soloS : 0;
    const clearPixels = soloS > 0 ? (onScreenPixels * clearS) / soloS : 0;

    // 2b. 1台ごとの標本点（建物と地面を深度だけ描いた上に、点を 1 画素ずつ描いて、その画素に描けたかを読む）
    let items: VisibilityResult['items'] = null;
    if (targets.samples && targets.samples.points.length >= 3) {
      items = measureItems(renderer, scene, camera, saved, rt, targets, options, covers, sc);
    }

    // 3. 建物の画面の占有率（地面を深度だけ描き、建物を描く）
    let buildingShare: number | null = null;
    if (options.buildings && options.buildings.length > 0) {
      renderer.clear(true, true, true);
      showExcept(saved, [...targets.subjects, ...(targets.hide ?? []), ...(options.exclude ?? []), ...options.buildings]);
      color.setMask(false);
      color.setLocked(true);
      renderer.render(scene, camera);
      color.setLocked(false);
      color.setMask(true);
      showOnly(saved, options.buildings);
      renderer.render(scene, camera);
      const c = readAlpha(renderer, rt, Ws, Hs);
      let n = 0;
      for (let i = 3; i < c.length; i += 4) if (c[i]! > 0) n++;
      buildingShare = n / (Ws * Hs);
    }

    const ratio = (x: number): number => (subjectPixels > 0 ? x / subjectPixels : 0);
    return {
      width: W,
      height: H,
      expand: k,
      subjectPixels,
      onScreenPixels,
      soloPixels,
      unoccludedPixels,
      clearPixels,
      onScreen: ratio(onScreenPixels),
      unoccluded: ratio(unoccludedPixels),
      clear: ratio(clearPixels),
      occludedOnScreen: onScreenPixels > 0 ? 1 - unoccludedPixels / onScreenPixels : 0,
      bbox: onScreenPixels > 0 ? { left: bx0, top: by0, right: bx1 + 1, bottom: by1 + 1 } : null,
      screenShare: clearPixels / (W * H),
      buildingShare,
      items,
    };
  } finally {
    color.setLocked(false);
    color.setMask(true);
    restore(renderer, scene, saved);
    targets.prepare?.(camera, H);
    rtEx.dispose();
    rt.dispose();
  }
}

/** 標本点を描く回数（隣り合う自転車の点が同じ画素に重ならないよう、物の番号の余りで分けて描く）。 */
const ITEM_BATCHES = 7;

function measureItems(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  saved: SavedState,
  rt: WebGLRenderTarget,
  targets: MeasureTargets,
  options: VisibilityOptions,
  covers: readonly CoverRect[],
  sc: number,
): VisibilityItems {
  const { points, perItem } = targets.samples!;
  const n = Math.floor(points.length / 3);
  const items = Math.floor(n / perItem);
  const Ws = rt.width;
  const Hs = rt.height;
  const color = renderer.state.buffers.color;
  // 標本点の画素の位置（描画先の画素。画面の外・カメラの後ろは -1）
  camera.updateMatrixWorld();
  const vp = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const v = new Vector3();
  const px = new Int32Array(n).fill(-1);
  const py = new Int32Array(n).fill(-1);
  const covered = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    v.set(points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!).applyMatrix4(vp);
    if (!Number.isFinite(v.x) || v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
    const x = Math.min(Ws - 1, Math.floor(((v.x + 1) / 2) * Ws));
    const y = Math.min(Hs - 1, Math.floor(((v.y + 1) / 2) * Hs));
    px[i] = x;
    py[i] = y;
    const cx = (x + 0.5) / sc;
    const cy = (Hs - 1 - y + 0.5) / sc;
    covered[i] = covers.some((c) => cx >= c.left && cx < c.right && cy >= c.top && cy < c.bottom) ? 1 : 0;
  }
  // 遮るもの（主役を除く）を深度だけ描く
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, true);
  showExcept(saved, [...targets.subjects, ...(targets.hide ?? []), ...(options.exclude ?? [])]);
  color.setMask(false);
  color.setLocked(true);
  renderer.render(scene, camera);
  color.setLocked(false);
  color.setMask(true);
  for (const o of saved.visible.keys()) o.visible = o === scene;
  // 点は深度を書かない（点どうしで隠し合わない）
  const material = new PointsMaterial({ size: 1, sizeAttenuation: false, color: 0xffffff, fog: false, depthWrite: false });
  const seen = new Uint8Array(n);
  const pixel = new Uint8Array(4);
  try {
    for (let slot = 0; slot < perItem; slot++) {
      for (let b = 0; b < ITEM_BATCHES; b++) {
        const idx: number[] = [];
        for (let it = b; it < items; it += ITEM_BATCHES) {
          const i = it * perItem + slot;
          if (px[i]! >= 0) idx.push(i);
        }
        if (idx.length === 0) continue;
        const pos = new Float32Array(idx.length * 3);
        idx.forEach((i, k) => pos.set(points.subarray(i * 3, i * 3 + 3), k * 3));
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(pos, 3));
        const cloud = new Points(geometry, material);
        cloud.frustumCulled = false;
        scene.add(cloud);
        renderer.clear(true, false, false);
        renderer.render(scene, camera);
        cloud.removeFromParent();
        geometry.dispose();
        for (const i of idx) {
          renderer.readRenderTargetPixels(rt, px[i]!, py[i]!, 1, 1, pixel);
          if (pixel[3]! > 0) seen[i] = 1;
        }
      }
    }
  } finally {
    material.dispose();
  }
  let visible = 0;
  let clear = 0;
  let framed = 0;
  const need = Math.floor(perItem / 2) + 1;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let it = 0; it < items; it++) {
    let a = 0;
    let c = 0;
    let fr = 0;
    for (let k = 0; k < perItem; k++) {
      const i = it * perItem + k;
      if (px[i]! >= 0) {
        if (!covered[i]) fr++;
        const x = (px[i]! + 0.5) / sc;
        const y = (Hs - 1 - py[i]! + 0.5) / sc;
        bx0 = Math.min(bx0, x);
        bx1 = Math.max(bx1, x);
        by0 = Math.min(by0, y);
        by1 = Math.max(by1, y);
      }
      if (seen[i]) {
        a++;
        if (!covered[i]) c++;
      }
    }
    if (a >= need) visible++;
    if (c >= need) clear++;
    if (fr >= need) framed++;
  }
  const frac = (v: number): number => (items > 0 ? v / items : 0);
  return {
    total: items,
    visible,
    clear,
    visibleFraction: frac(visible),
    clearFraction: frac(clear),
    framed,
    framedFraction: frac(framed),
    bbox: bx0 <= bx1 ? { left: bx0, top: by0, right: bx1, bottom: by1 } : null,
  };
}

/**
 * 建物の画面の占有率だけを測る（場面の間の移動の確認用。主役は描かない）。
 */
export function measureBuildingShare(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  buildings: Object3D[],
  size: { width: number; height: number },
  exclude: Object3D[] = [],
): number {
  const W = Math.max(1, Math.round(size.width));
  const H = Math.max(1, Math.round(size.height));
  const saved = save(renderer, scene);
  const rt = new WebGLRenderTarget(W, H, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: true });
  const color = renderer.state.buffers.color;
  try {
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    showExcept(saved, [...buildings, ...exclude]);
    color.setMask(false);
    color.setLocked(true);
    renderer.render(scene, camera);
    color.setLocked(false);
    color.setMask(true);
    showOnly(saved, buildings);
    renderer.render(scene, camera);
    const c = readAlpha(renderer, rt, W, H);
    let n = 0;
    for (let i = 3; i < c.length; i += 4) if (c[i]! > 0) n++;
    return n / (W * H);
  } finally {
    color.setLocked(false);
    color.setMask(true);
    restore(renderer, scene, saved);
    rt.dispose();
  }
}
