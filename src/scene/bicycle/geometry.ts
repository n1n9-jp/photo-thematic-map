/**
 * 日本のシティサイクル（ママチャリ）の形状をコードで生成する。
 *
 * 座標: 原点は接地面の中央、進行方向 +X、上 +Y、右手側 +Z。1単位=1m。
 * 実寸: 全長 約1.8m・幅 約0.6m（ハンドル）・高さ 約1.05m。
 *
 * 頂点属性:
 * - position / normal
 * - color: 頂点カラー（線形 RGB）。フレーム部分は白（インスタンス色をそのまま出す）。
 * - frameMask: 1 ならインスタンスごとのフレーム色を掛ける。0 なら頂点カラーのまま。
 *
 * 3つの詳細度（LOD）は同じ寸法表 `BIKE_DIMENSIONS` から作るので、遠景でも輪郭が近景と一致する。
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';

/** 詳細度。0=近景、1=中景、2=遠景。 */
export type BicycleLod = 0 | 1 | 2;

/** 各詳細度の三角形数の上限。 */
export const LOD_TRIANGLE_BUDGET: readonly [number, number, number] = [1500, 300, 40];

/** 形状の基準寸法(m)。すべての LOD で共有する。 */
export const BIKE_DIMENSIONS = {
  /** タイヤ外径の半径（26インチ相当）。 */
  wheelRadius: 0.33,
  /** タイヤ断面の半径。 */
  tireTube: 0.022,
  /** 後輪・前輪の車軸の X 座標。 */
  rearAxleX: -0.55,
  frontAxleX: 0.55,
  /** ボトムブラケット（クランク軸）。 */
  bottomBracket: [-0.08, 0.27] as const,
  /** ヘッドチューブ下端と上端。 */
  headLow: [0.42, 0.6] as const,
  headHigh: [0.333, 0.78] as const,
  /** シートチューブ上端。 */
  seatTop: [-0.25, 0.8] as const,
  /** サドル中心。 */
  saddle: [-0.29, 0.9] as const,
  /** ハンドルの最も高い位置とグリップ端の半幅。 */
  handleTopY: 1.03,
  handleHalfWidth: 0.29,
  /** 前かご（x 範囲、y 範囲、半幅）。 */
  basketX: [0.5, 0.87] as const,
  basketY: [0.71, 0.95] as const,
  basketHalfWidth: 0.19,
  /** 荷台（x 範囲、高さ、半幅）。 */
  rackX: [-0.86, -0.38] as const,
  rackY: 0.74,
  rackHalfWidth: 0.075,
} as const;

/** 部品の色（sRGB）。フレーム部分はインスタンス色で塗る。 */
export const PART_COLORS = {
  tire: 0x161616,
  rim: 0xb9bcc0,
  silver: 0xc4c7cb,
  darkMetal: 0x4a4c50,
  saddle: 0x2a2320,
  grip: 0x1d1b1a,
  reflector: 0xc8231c,
  lamp: 0xd9d6c8,
  /** 中景・遠景のかご。ワイヤー越しに奥が透けて見える平均の明るさとして、銀より暗くする。 */
  basketFar: 0x85888c,
} as const;

/** 内部用: 部品を積み上げるビルダー。 */
class PartBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private masks: number[] = [];
  private indices: number[] = [];
  private readonly tmpColor = new Color();

  /** three の BufferGeometry を部品として加える（index 付き・なし両対応）。 */
  addGeometry(geo: BufferGeometry, colorHex: number | 'frame', matrix?: Matrix4): void {
    const g = matrix ? geo.clone().applyMatrix4(matrix) : geo;
    const pos = g.getAttribute('position');
    let nrm = g.getAttribute('normal');
    if (!nrm) {
      g.computeVertexNormals();
      nrm = g.getAttribute('normal');
    }
    const base = this.positions.length / 3;
    const isFrame = colorHex === 'frame';
    if (isFrame) this.tmpColor.setRGB(1, 1, 1);
    else this.tmpColor.setHex(colorHex);
    for (let i = 0; i < pos.count; i++) {
      this.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      this.normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      this.colors.push(this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
      this.masks.push(isFrame ? 1 : 0);
    }
    const index = g.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) this.indices.push(base + i);
    }
    if (g !== geo) g.dispose();
  }

  /** 2点間の円筒（両端は開放）。 */
  tube(a: Vector3, b: Vector3, radius: number, segments: number, color: number | 'frame'): void {
    const dir = new Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-6) return;
    const geo = new CylinderGeometry(radius, radius, len, segments, 1, true);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
    const m = new Matrix4().compose(new Vector3().addVectors(a, b).multiplyScalar(0.5), q, new Vector3(1, 1, 1));
    this.addGeometry(geo, color, m);
    geo.dispose();
  }

  /** 点列を通る曲がった管。 */
  curve(points: Vector3[], radius: number, tubular: number, radial: number, color: number | 'frame'): void {
    const curve = new CatmullRomCurve3(points, false, 'centripetal');
    const geo = new TubeGeometry(curve, tubular, radius, radial, false);
    this.addGeometry(geo, color);
    geo.dispose();
  }

  /** 箱。rotation はオイラー角ではなく四元数で受ける。 */
  box(center: Vector3, size: Vector3, color: number | 'frame', rotation?: Quaternion): void {
    const geo = new BoxGeometry(size.x, size.y, size.z);
    const m = new Matrix4().compose(center, rotation ?? new Quaternion(), new Vector3(1, 1, 1));
    this.addGeometry(geo, color, m);
    geo.dispose();
  }

  /** 箱の側面4枚だけ（上下なし）。8 三角形。 */
  openBox(min: Vector3, max: Vector3, color: number | 'frame', withBottom: boolean): void {
    const quads: Vector3[][] = [
      // 前・後・左・右
      [new Vector3(max.x, min.y, min.z), new Vector3(max.x, min.y, max.z), new Vector3(max.x, max.y, max.z), new Vector3(max.x, max.y, min.z)],
      [new Vector3(min.x, min.y, max.z), new Vector3(min.x, min.y, min.z), new Vector3(min.x, max.y, min.z), new Vector3(min.x, max.y, max.z)],
      [new Vector3(min.x, min.y, min.z), new Vector3(max.x, min.y, min.z), new Vector3(max.x, max.y, min.z), new Vector3(min.x, max.y, min.z)],
      [new Vector3(max.x, min.y, max.z), new Vector3(min.x, min.y, max.z), new Vector3(min.x, max.y, max.z), new Vector3(max.x, max.y, max.z)],
    ];
    if (withBottom) {
      quads.push([new Vector3(min.x, min.y, min.z), new Vector3(min.x, min.y, max.z), new Vector3(max.x, min.y, max.z), new Vector3(max.x, min.y, min.z)]);
    }
    for (const q of quads) this.quad(q, color);
  }

  /** 四角形1枚（2 三角形）。法線は頂点の巻き順から求める。 */
  quad(v: Vector3[], color: number | 'frame'): void {
    const [a, b, c, d] = v as [Vector3, Vector3, Vector3, Vector3];
    this.polygonStrip([a, b, c, d], [[0, 1, 2], [0, 2, 3]], color);
  }

  /** 任意の頂点と三角形の組。法線は面法線を頂点ごとに平均。 */
  polygonStrip(verts: Vector3[], tris: [number, number, number][], color: number | 'frame'): void {
    const geo = new BufferGeometry();
    const arr = new Float32Array(verts.length * 3);
    verts.forEach((v, i) => v.toArray(arr, i * 3));
    geo.setAttribute('position', new BufferAttribute(arr, 3));
    geo.setIndex(tris.flat());
    geo.computeVertexNormals();
    this.addGeometry(geo, color);
    geo.dispose();
  }

  /** XY 平面（z 固定）上の円環（遠景の車輪）。segments 枚の四角形。 */
  flatRing(cx: number, cy: number, z: number, rOuter: number, rInner: number, segments: number, color: number | 'frame'): void {
    const verts: Vector3[] = [];
    const tris: [number, number, number][] = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2 + Math.PI / 2;
      verts.push(new Vector3(cx + Math.cos(t) * rOuter, cy + Math.sin(t) * rOuter, z));
      verts.push(new Vector3(cx + Math.cos(t) * rInner, cy + Math.sin(t) * rInner, z));
    }
    for (let i = 0; i < segments; i++) {
      const o0 = i * 2;
      const i0 = o0 + 1;
      const o1 = ((i + 1) % segments) * 2;
      const i1 = o1 + 1;
      tris.push([o0, i0, o1], [o1, i0, i1]);
    }
    this.polygonStrip(verts, tris, color);
  }

  /**
   * 車輪を囲む円弧の帯（泥よけ）。角度は +X から反時計回り（ラジアン）。
   * 断面は浅い U 字（3頂点）で、segments 区間 × 4 三角形。
   */
  arcStrip(cx: number, cy: number, radius: number, halfWidth: number, a0: number, a1: number, segments: number, color: number | 'frame', channel: boolean): void {
    const verts: Vector3[] = [];
    const tris: [number, number, number][] = [];
    const cols = channel ? 3 : 2;
    for (let i = 0; i <= segments; i++) {
      const t = a0 + ((a1 - a0) * i) / segments;
      const cs = Math.cos(t);
      const sn = Math.sin(t);
      if (channel) {
        const rEdge = radius - 0.018;
        verts.push(new Vector3(cx + cs * rEdge, cy + sn * rEdge, -halfWidth));
        verts.push(new Vector3(cx + cs * radius, cy + sn * radius, 0));
        verts.push(new Vector3(cx + cs * rEdge, cy + sn * rEdge, halfWidth));
      } else {
        verts.push(new Vector3(cx + cs * radius, cy + sn * radius, -halfWidth));
        verts.push(new Vector3(cx + cs * radius, cy + sn * radius, halfWidth));
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = i * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        tris.push([a, d, b], [b, d, e]);
      }
    }
    this.polygonStrip(verts, tris, color);
  }

  /** 平面多角形を厚み付きで（XY 平面上の凸多角形を z0..z1 で押し出す）。 */
  extrudedConvex(outline: [number, number][], z0: number, z1: number, color: number | 'frame'): void {
    const n = outline.length;
    // 天面・底面（ファン）
    for (const z of [z0, z1]) {
      const verts = outline.map(([x, y]) => new Vector3(x, y, z));
      const tris: [number, number, number][] = [];
      for (let i = 1; i < n - 1; i++) tris.push(z === z1 ? [0, i, i + 1] : [0, i + 1, i]);
      this.polygonStrip(verts, tris, color);
    }
    // 側面
    const verts: Vector3[] = [];
    const tris: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = outline[i] as [number, number];
      const [x1, y1] = outline[(i + 1) % n] as [number, number];
      const k = verts.length;
      verts.push(new Vector3(x0, y0, z0), new Vector3(x1, y1, z0), new Vector3(x1, y1, z1), new Vector3(x0, y0, z1));
      tris.push([k, k + 1, k + 2], [k, k + 2, k + 3]);
    }
    this.polygonStrip(verts, tris, color);
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geo.setAttribute('frameMask', new BufferAttribute(new Float32Array(this.masks), 1));
    const vertexCount = this.positions.length / 3;
    geo.setIndex(new BufferAttribute(vertexCount > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices), 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

const v = (x: number, y: number, z = 0): Vector3 => new Vector3(x, y, z);

/** 車輪の中心高さ。 */
const AXLE_Y = BIKE_DIMENSIONS.wheelRadius;

/** ハンドル（スイープバックのシティバー）の通過点。 */
function handlebarPoints(): Vector3[] {
  const D = BIKE_DIMENSIONS;
  const w = D.handleHalfWidth;
  const top = D.handleTopY;
  return [
    v(0.1, top - 0.03, -w),
    v(0.2, top - 0.01, -w + 0.02),
    v(0.29, top, -w + 0.13),
    v(0.31, top - 0.01, 0),
    v(0.29, top, w - 0.13),
    v(0.2, top - 0.01, w - 0.02),
    v(0.1, top - 0.03, w),
  ];
}

/** 前フレーム（ヘッド下端 → 低く湾曲 → BB）の通過点。またぎやすい U 字フレーム。 */
function mainFramePoints(): Vector3[] {
  const D = BIKE_DIMENSIONS;
  return [
    v(D.headLow[0], D.headLow[1]),
    v(0.3, 0.44),
    v(0.12, 0.31),
    v(D.bottomBracket[0] + 0.02, D.bottomBracket[1] + 0.005),
  ];
}

/** ヘッドチューブ方向の単位ベクトル（下→上）。 */
function headDir(): Vector3 {
  const D = BIKE_DIMENSIONS;
  return v(D.headHigh[0] - D.headLow[0], D.headHigh[1] - D.headLow[1]).normalize();
}

/** 近景用（スポーク省略、タイヤとリムが分かる形）。 */
function buildNear(): BufferGeometry {
  const D = BIKE_DIMENSIONS;
  const b = new PartBuilder();
  const axles = [D.rearAxleX, D.frontAxleX];

  // 車輪: タイヤ（黒）・リム（銀）・ハブ
  for (const ax of axles) {
    const tire = new TorusGeometry(D.wheelRadius - D.tireTube, D.tireTube, 4, 20);
    b.addGeometry(tire, PART_COLORS.tire, new Matrix4().makeTranslation(ax, AXLE_Y, 0));
    tire.dispose();
    const rim = new TorusGeometry(D.wheelRadius - D.tireTube * 2 - 0.008, 0.011, 3, 20);
    b.addGeometry(rim, PART_COLORS.rim, new Matrix4().makeTranslation(ax, AXLE_Y, 0));
    rim.dispose();
    b.tube(v(ax, AXLE_Y, -0.055), v(ax, AXLE_Y, 0.055), 0.028, 6, PART_COLORS.silver);
  }

  // フレーム（インスタンス色）
  b.curve(mainFramePoints(), 0.022, 6, 6, 'frame');
  const bb = v(D.bottomBracket[0], D.bottomBracket[1]);
  b.tube(bb, v(D.seatTop[0], D.seatTop[1]), 0.017, 6, 'frame');
  const hd = headDir();
  const headLow = v(D.headLow[0], D.headLow[1]);
  b.tube(headLow.clone().addScaledVector(hd, -0.02), v(D.headHigh[0], D.headHigh[1]), 0.02, 6, 'frame');
  for (const s of [-1, 1]) {
    const axle = v(D.rearAxleX, AXLE_Y, 0.065 * s);
    b.tube(v(bb.x, bb.y, 0.03 * s), axle, 0.009, 4, 'frame');
    b.tube(v(D.seatTop[0] + 0.02, D.seatTop[1] - 0.09, 0.02 * s), axle, 0.009, 4, 'frame');
    // フロントフォーク
    b.tube(headLow.clone().setZ(0.035 * s), v(D.frontAxleX, AXLE_Y, 0.05 * s), 0.011, 4, 'frame');
  }
  // チェーンケース（右側）
  b.extrudedConvex(
    [
      [D.rearAxleX - 0.05, AXLE_Y - 0.03],
      [D.rearAxleX + 0.02, AXLE_Y - 0.06],
      [bb.x - 0.02, bb.y - 0.11],
      [bb.x + 0.08, bb.y - 0.09],
      [bb.x + 0.12, bb.y],
      [bb.x + 0.08, bb.y + 0.09],
      [bb.x - 0.02, bb.y + 0.11],
      [D.rearAxleX + 0.02, AXLE_Y + 0.06],
      [D.rearAxleX - 0.05, AXLE_Y + 0.03],
    ],
    0.075,
    0.1,
    'frame',
  );
  // クランクとペダル
  for (const s of [-1, 1]) {
    const pedal = v(bb.x + 0.12 * s, bb.y - 0.12 * s, 0.13 * s);
    b.tube(v(bb.x, bb.y, 0.11 * s), pedal, 0.011, 4, PART_COLORS.darkMetal);
    b.box(pedal.clone().setZ(0.17 * s), v(0.09, 0.022, 0.08), PART_COLORS.grip);
  }

  // ステム・ハンドル・グリップ
  const stemTop = v(0.315, D.handleTopY - 0.02);
  b.tube(v(D.headHigh[0], D.headHigh[1]), stemTop, 0.014, 6, PART_COLORS.silver);
  const hp = handlebarPoints();
  b.curve(hp, 0.012, 12, 4, PART_COLORS.silver);
  for (const s of [-1, 1]) {
    const end = hp[s < 0 ? 0 : hp.length - 1] as Vector3;
    const inner = hp[s < 0 ? 1 : hp.length - 2] as Vector3;
    const dir = inner.clone().sub(end).normalize();
    b.tube(end.clone().addScaledVector(dir, -0.01), end.clone().addScaledVector(dir, 0.11), 0.018, 6, PART_COLORS.grip);
  }

  // シートポスト・サドル
  b.tube(v(D.seatTop[0], D.seatTop[1]), v(D.saddle[0] + 0.01, D.saddle[1] - 0.03), 0.013, 6, PART_COLORS.silver);
  const saddle = new SphereGeometry(1, 8, 5);
  b.addGeometry(
    saddle,
    PART_COLORS.saddle,
    new Matrix4().compose(v(D.saddle[0], D.saddle[1]), new Quaternion(), new Vector3(0.15, 0.045, 0.11)),
  );
  saddle.dispose();

  // 泥よけ（銀）。前は前方下から後方まで、後ろは上前方から後方下まで。
  b.arcStrip(D.frontAxleX, AXLE_Y, D.wheelRadius + 0.035, 0.038, -0.25, Math.PI * 0.95, 9, PART_COLORS.silver, true);
  b.arcStrip(D.rearAxleX, AXLE_Y, D.wheelRadius + 0.035, 0.038, Math.PI * 0.2, Math.PI * 1.15, 9, PART_COLORS.silver, true);
  // 後ろの反射板
  const refl = Math.PI * 1.1;
  b.box(
    v(D.rearAxleX + Math.cos(refl) * (D.wheelRadius + 0.04), AXLE_Y + Math.sin(refl) * (D.wheelRadius + 0.04)),
    v(0.012, 0.05, 0.05),
    PART_COLORS.reflector,
  );

  // 荷台（銀）: 2本のレール、横桟、車軸へのステー
  const [rx0, rx1] = D.rackX;
  const ry = D.rackY;
  const rw = D.rackHalfWidth;
  for (const s of [-1, 1]) {
    b.tube(v(rx0, ry, rw * s), v(rx1, ry, rw * s), 0.008, 4, PART_COLORS.silver);
    b.tube(v(rx0 + 0.04, ry, rw * s), v(D.rearAxleX, AXLE_Y, 0.07 * s), 0.008, 4, PART_COLORS.silver);
    b.tube(v(rx0 + 0.3, ry, rw * s), v(D.rearAxleX + 0.02, AXLE_Y, 0.07 * s), 0.008, 4, PART_COLORS.silver);
  }
  for (const x of [rx0, (rx0 + rx1) / 2, rx1]) b.tube(v(x, ry, -rw), v(x, ry, rw), 0.008, 4, PART_COLORS.silver);

  // 両立スタンド（銀）: 車軸から斜め後ろ下の接地バーへ
  const standX = D.rearAxleX - 0.12;
  for (const s of [-1, 1]) {
    b.tube(v(D.rearAxleX, AXLE_Y, 0.07 * s), v(standX, 0.01, 0.13 * s), 0.009, 4, PART_COLORS.silver);
  }
  b.tube(v(standX, 0.01, -0.13), v(standX, 0.01, 0.13), 0.01, 4, PART_COLORS.silver);

  // 前かご（銀のワイヤー）: 上下の枠、縦の桟、底板、ステー
  const [bx0, bx1] = D.basketX;
  const [by0, by1] = D.basketY;
  const bw = D.basketHalfWidth;
  const ring = (y: number, r: number): void => {
    b.tube(v(bx0, y, -bw), v(bx1, y, -bw), r, 3, PART_COLORS.silver);
    b.tube(v(bx0, y, bw), v(bx1, y, bw), r, 3, PART_COLORS.silver);
    b.tube(v(bx0, y, -bw), v(bx0, y, bw), r, 3, PART_COLORS.silver);
    b.tube(v(bx1, y, -bw), v(bx1, y, bw), r, 3, PART_COLORS.silver);
  };
  ring(by1, 0.007);
  ring(by0, 0.006);
  ring((by0 + by1) / 2, 0.004);
  const nx = 4;
  const nz = 5;
  for (let i = 1; i < nx; i++) {
    const x = bx0 + ((bx1 - bx0) * i) / nx;
    for (const s of [-1, 1]) b.tube(v(x, by0, bw * s), v(x, by1, bw * s), 0.004, 3, PART_COLORS.silver);
  }
  for (let i = 0; i <= nz; i++) {
    const z = -bw + (2 * bw * i) / nz;
    for (const x of [bx0, bx1]) b.tube(v(x, by0, z), v(x, by1, z), 0.004, 3, PART_COLORS.silver);
  }
  b.quad([v(bx0, by0 + 0.003, -bw), v(bx0, by0 + 0.003, bw), v(bx1, by0 + 0.003, bw), v(bx1, by0 + 0.003, -bw)], PART_COLORS.darkMetal);
  for (const s of [-1, 1]) {
    b.tube(v(bx1 - 0.03, by0, 0.08 * s), v(D.frontAxleX, AXLE_Y, 0.055 * s), 0.006, 3, PART_COLORS.silver);
  }
  // ライト（かごの下）
  b.tube(v(bx1 - 0.02, by0 - 0.06, 0), v(bx1 + 0.05, by0 - 0.06, 0), 0.03, 6, PART_COLORS.lamp);

  return b.build();
}

/** 中景用（300 三角形以下）。 */
function buildMid(): BufferGeometry {
  const D = BIKE_DIMENSIONS;
  const b = new PartBuilder();
  for (const ax of [D.rearAxleX, D.frontAxleX]) {
    const tire = new TorusGeometry(D.wheelRadius - 0.028, 0.028, 3, 10);
    b.addGeometry(tire, PART_COLORS.tire, new Matrix4().makeTranslation(ax, AXLE_Y, 0));
    tire.dispose();
  }
  b.curve(mainFramePoints(), 0.024, 3, 4, 'frame');
  const bb = v(D.bottomBracket[0], D.bottomBracket[1]);
  b.tube(bb, v(D.seatTop[0], D.seatTop[1]), 0.02, 4, 'frame');
  b.tube(v(D.headLow[0], D.headLow[1]), v(D.headHigh[0], D.headHigh[1]), 0.024, 4, 'frame');
  b.tube(v(D.headLow[0], D.headLow[1]), v(D.frontAxleX, AXLE_Y), 0.016, 4, 'frame');
  b.tube(bb, v(D.rearAxleX, AXLE_Y), 0.016, 4, 'frame');
  b.tube(v(D.seatTop[0] + 0.02, D.seatTop[1] - 0.09), v(D.rearAxleX, AXLE_Y), 0.014, 4, 'frame');
  // チェーンケース（平板）
  b.quad(
    [v(D.rearAxleX, AXLE_Y - 0.05, 0.09), v(bb.x + 0.1, bb.y - 0.09, 0.09), v(bb.x + 0.1, bb.y + 0.09, 0.09), v(D.rearAxleX, AXLE_Y + 0.05, 0.09)],
    'frame',
  );
  // ステム・ハンドル（3区間）
  b.tube(v(D.headHigh[0], D.headHigh[1]), v(0.315, D.handleTopY - 0.02), 0.016, 3, PART_COLORS.silver);
  const hp = handlebarPoints();
  const hIdx = [0, 2, 4, 6];
  for (let i = 0; i < hIdx.length - 1; i++) {
    b.tube(hp[hIdx[i] as number] as Vector3, hp[hIdx[i + 1] as number] as Vector3, 0.015, 4, i === 1 ? PART_COLORS.silver : PART_COLORS.grip);
  }
  // サドル
  b.openBox(v(D.saddle[0] - 0.14, D.saddle[1] - 0.035, -0.1), v(D.saddle[0] + 0.13, D.saddle[1] + 0.04, 0.1), PART_COLORS.saddle, false);
  b.quad(
    [v(D.saddle[0] - 0.14, D.saddle[1] + 0.04, -0.1), v(D.saddle[0] - 0.14, D.saddle[1] + 0.04, 0.1), v(D.saddle[0] + 0.13, D.saddle[1] + 0.04, 0.1), v(D.saddle[0] + 0.13, D.saddle[1] + 0.04, -0.1)],
    PART_COLORS.saddle,
  );
  // 泥よけ
  b.arcStrip(D.frontAxleX, AXLE_Y, D.wheelRadius + 0.035, 0.04, -0.25, Math.PI * 0.95, 4, PART_COLORS.silver, false);
  b.arcStrip(D.rearAxleX, AXLE_Y, D.wheelRadius + 0.035, 0.04, Math.PI * 0.2, Math.PI * 1.15, 4, PART_COLORS.silver, false);
  // 荷台（板）
  b.openBox(v(D.rackX[0], D.rackY - 0.01, -D.rackHalfWidth), v(D.rackX[1], D.rackY + 0.01, D.rackHalfWidth), PART_COLORS.silver, true);
  // スタンド
  b.tube(v(D.rearAxleX, AXLE_Y), v(D.rearAxleX - 0.12, 0.01), 0.02, 3, PART_COLORS.silver);
  // 前かご（底つきの箱）
  b.openBox(
    v(D.basketX[0], D.basketY[0], -D.basketHalfWidth),
    v(D.basketX[1], D.basketY[1], D.basketHalfWidth),
    PART_COLORS.basketFar,
    true,
  );
  return b.build();
}

/** 遠景用（40 三角形以下）。輪郭は近景と同じ寸法で作る。 */
function buildFar(): BufferGeometry {
  const D = BIKE_DIMENSIONS;
  const b = new PartBuilder();
  for (const ax of [D.rearAxleX, D.frontAxleX]) {
    b.flatRing(ax, AXLE_Y, 0, D.wheelRadius, D.wheelRadius - 0.07, 6, PART_COLORS.tire);
  }
  // フレームの帯: ヘッド → BB → シート上端（XY 平面の帯 2 区間）
  const w = 0.035;
  const head = v(D.headHigh[0], D.headHigh[1]);
  const bb = v(D.bottomBracket[0] + 0.05, D.bottomBracket[1] + 0.02);
  const seat = v(D.saddle[0], D.saddle[1]);
  b.polygonStrip(
    [head.clone().setX(head.x - w), head.clone().setX(head.x + w), bb.clone().setY(bb.y + w), bb.clone().setY(bb.y - w), seat.clone().setX(seat.x - w), seat.clone().setX(seat.x + w)],
    [[0, 3, 1], [0, 2, 3], [2, 4, 3], [3, 4, 5]],
    'frame',
  );
  // ハンドル（水平の板）
  b.quad(
    [v(0.1, D.handleTopY - 0.02, -D.handleHalfWidth), v(0.1, D.handleTopY - 0.02, D.handleHalfWidth), v(0.31, D.handleTopY - 0.02, D.handleHalfWidth), v(0.31, D.handleTopY - 0.02, -D.handleHalfWidth)],
    PART_COLORS.silver,
  );
  // 前かご（側面4枚）
  b.openBox(
    v(D.basketX[0], D.basketY[0], -D.basketHalfWidth),
    v(D.basketX[1], D.basketY[1], D.basketHalfWidth),
    PART_COLORS.basketFar,
    false,
  );
  return b.build();
}

/** 指定した詳細度のママチャリ形状を生成する。 */
export function createBicycleGeometry(lod: BicycleLod): BufferGeometry {
  switch (lod) {
    case 0:
      return buildNear();
    case 1:
      return buildMid();
    case 2:
      return buildFar();
  }
}

/** 形状の三角形数。 */
export function triangleCount(geo: BufferGeometry): number {
  const index = geo.getIndex();
  return (index ? index.count : geo.getAttribute('position').count) / 3;
}

/** フレーム色のパレット項目。 */
export interface FrameColorEntry {
  name: string;
  /** sRGB 16進。 */
  hex: number;
  /** 出現割合（合計 1）。 */
  weight: number;
}

/**
 * 日本の駐輪場で見かけるフレーム色の割合（目安）。
 * 銀と黒が多く、紺・白が続き、赤・緑・水色などが少しずつ混ざる。
 */
export const FRAME_PALETTE: readonly FrameColorEntry[] = [
  { name: '銀', hex: 0xb4b8bd, weight: 0.27 },
  { name: '黒', hex: 0x1e1f22, weight: 0.2 },
  { name: '紺', hex: 0x1d2a52, weight: 0.12 },
  { name: '白', hex: 0xeceae4, weight: 0.12 },
  { name: '赤', hex: 0xa3201f, weight: 0.07 },
  { name: '緑', hex: 0x2c5a3a, weight: 0.06 },
  { name: '水色', hex: 0x7cb7d6, weight: 0.06 },
  { name: 'ベージュ', hex: 0xcdbb98, weight: 0.04 },
  { name: 'ピンク', hex: 0xd99aa8, weight: 0.03 },
  { name: '茶', hex: 0x5a3b28, weight: 0.03 },
];

/** 0..1 の乱数からパレットの色（sRGB 16進）を選ぶ。 */
export function pickFrameColor(u: number): number {
  let acc = 0;
  for (const e of FRAME_PALETTE) {
    acc += e.weight;
    if (u < acc) return e.hex;
  }
  return (FRAME_PALETTE[FRAME_PALETTE.length - 1] as FrameColorEntry).hex;
}
