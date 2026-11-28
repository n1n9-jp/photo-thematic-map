import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/scene/palette';
import { CVD_KINDS, deltaE } from './helpers/colorDifference';

const tokens = readFileSync(join(__dirname, '../../src/styles/tokens.css'), 'utf8');
const ACCENT = Number.parseInt(/--ptm-accent:\s*#([0-9a-f]{6})/i.exec(tokens)![1]!, 16);

describe('街の配色', () => {
  const p = PALETTE;
  it('駅の柱の5色: 全ての組が通常の色覚で ΔE 15 以上、P・D・T 型で 8 以上離れている', () => {
    const c = p.stations;
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        expect(deltaE(c[i]!, c[j]!), `${i}-${j}`).toBeGreaterThanOrEqual(15);
        for (const kind of CVD_KINDS) expect(deltaE(c[i]!, c[j]!, kind), `${i}-${j} ${kind}`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('駅の柱の色は、地面から離れ、駐輪場の空きの2色とアクセントの赤と混同しない', () => {
    for (const c of p.stations) {
      expect(deltaE(c, p.land)).toBeGreaterThanOrEqual(20);
      for (const ref of [p.vacancy.enough, p.vacancy.short, ACCENT]) {
        expect(deltaE(c, ref)).toBeGreaterThanOrEqual(15);
        expect(Math.min(deltaE(c, ref, 'protan'), deltaE(c, ref, 'deutan'))).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('陸と海、空と地面、建物と陸が見分けられる', () => {
    expect(deltaE(p.land, p.sea)).toBeGreaterThanOrEqual(10);
    expect(deltaE(p.sky, p.land)).toBeGreaterThanOrEqual(8);
    expect(deltaE(p.building, p.land)).toBeGreaterThanOrEqual(8);
  });

  it('いまの配色より明るい: 陸の明るさが中ほどより上、建物の陰の面（環境光と半球光の横向き）が白い面の半分以上（いままでは 2 割強）', () => {
    const lum = (c: number): number => (0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)) / 255;
    expect(lum(p.land)).toBeGreaterThan(lum(0x77746d) + 0.25);
    // 光の強さ π で白い面が元の色になる（three.js の物理的な単位）
    const shade = (p.lights.ambientIntensity + p.lights.hemisphereIntensity * 0.5) / Math.PI;
    expect(shade).toBeGreaterThanOrEqual(0.5);
  });
});
