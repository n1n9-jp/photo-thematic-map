/**
 * 色の差（OKLab のユークリッド距離 ×100）と、色覚の違いのシミュレーション（Machado, Oliveira & Fernandes 2009、重さ 1.0）。
 * 駅の柱の色の検証に使う（`docs/design/palette/README.md` の数値と同じ計算）。
 */
export type CvdKind = 'protan' | 'deutan' | 'tritan';
export const CVD_KINDS: readonly CvdKind[] = ['protan', 'deutan', 'tritan'];

const MACHADO: Record<CvdKind, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function linearRgb(hex: number): [number, number, number] {
  return [toLinear(((hex >> 16) & 255) / 255), toLinear(((hex >> 8) & 255) / 255), toLinear((hex & 255) / 255)];
}

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function simulate(rgb: [number, number, number], kind: CvdKind): [number, number, number] {
  const M = MACHADO[kind];
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  return [0, 1, 2].map((i) => clamp(M[i]![0]! * rgb[0] + M[i]![1]! * rgb[1] + M[i]![2]! * rgb[2])) as [number, number, number];
}

/** 2色の差（OKLab ΔE ×100）。kind を渡すと、その色覚で見たときの差。 */
export function deltaE(a: number, b: number, kind?: CvdKind): number {
  const pa = linearRgb(a);
  const pb = linearRgb(b);
  const la = oklab(kind ? simulate(pa, kind) : pa);
  const lb = oklab(kind ? simulate(pb, kind) : pb);
  return 100 * Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}
