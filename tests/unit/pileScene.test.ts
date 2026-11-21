import { DataUtils } from 'three';
import { describe, expect, it } from 'vitest';
import { computePileScene, countAtMost, latticeState, stageAt, type PileComputeResult } from '../../src/scene/pileScene/compute';
import { createPileSceneFromResult } from '../../src/scene/pileScene/pileScene';
import { createSyntheticCity } from '../../src/sim/syntheticCity';

const city = createSyntheticCity({ size: 240, seed: 3, minHeight: 4, maxHeight: 40 });

function compute(mode: 'full' | 'surface', count: number): PileComputeResult {
  return computePileScene(city.grid, { x: 0, z: 0, count, mode, stages: 12, earlyStages: 4 });
}

const full = compute('full', 30_000);
const surface = compute('surface', 120_000);

/** 段階 k の層のセル j の厚さ(m)。 */
function layerAt(r: PileComputeResult, k: number, j: number): number {
  return DataUtils.fromHalfFloat(r.layers[k * r.layerWidth * r.layerHeight + j]!);
}

/** 進み具合 t のセル j の厚さ(m)。 */
function thickAt(r: PileComputeResult, t: number, j: number): number {
  const { k, a } = stageAt(r.fractions, t);
  const k1 = Math.min(r.fractions.length - 1, k + 1);
  return layerAt(r, k, j) * (1 - a) + layerAt(r, k1, j) * a;
}

/** 自転車 i の中心のセル（層の並び）。 */
function cellOf(r: PileComputeResult, i: number): number {
  // 中心 = 位置 + 回した (0, 0.5, 0)
  const qx = r.quaternions[i * 4]!;
  const qy = r.quaternions[i * 4 + 1]!;
  const qz = r.quaternions[i * 4 + 2]!;
  const qw = r.quaternions[i * 4 + 3]!;
  // (0, 0.5, 0) を回す
  const cx = 2 * (qx * qy - qw * qz) * 0.5;
  const cz = 2 * (qy * qz + qw * qx) * 0.5;
  const x = r.origin.x + r.positions[i * 3]! + cx;
  const z = r.origin.z + r.positions[i * 3 + 2]! + cz;
  const cs = r.layerRect.cellSize;
  const c = Math.floor((x - r.layerRect.x0) / cs);
  const row = Math.floor((z - r.layerRect.z0) / cs);
  return row * r.layerWidth + c;
}

describe('山の場面の計算', () => {
  it('全台を詰める: 台数・体積・順位が揃い、同じ入力から同じ結果になる', () => {
    expect(full.placedCount).toBe(30_000);
    expect(full.representedCount).toBe(30_000);
    expect(full.volume).toBeCloseTo(30_000 * 0.35, -2);
    expect(full.positions.length).toBe(30_000 * 3);
    expect(full.spacing.length).toBe(0);
    for (let i = 1; i < full.arrivals.length; i++) expect(full.arrivals[i]!).toBeGreaterThanOrEqual(full.arrivals[i - 1]!);
    expect(full.fractions[0]).toBe(0);
    expect(full.fractions[full.fractions.length - 1]).toBe(1);
    // 最初の区間を細かく割っている（12 段階 + 4 分割 → 先頭の区間は 1/48）
    expect(full.fractions[1]).toBeCloseTo(1 / 48, 6);
    const again = compute('full', 30_000);
    expect(Array.from(again.positions.subarray(0, 300))).toEqual(Array.from(full.positions.subarray(0, 300)));
    expect(Array.from(again.colors.subarray(0, 300))).toEqual(Array.from(full.colors.subarray(0, 300)));
    expect(full.fillStats.maxBelowGround).toBeLessThan(0.01);
  });

  it('段階ごとの厚さは単調に増える', () => {
    const r = full;
    const cells = r.layerWidth * r.layerHeight;
    for (let k = 1; k < r.fractions.length; k++) {
      for (let j = 0; j < cells; j += 7) expect(layerAt(r, k, j)).toBeGreaterThanOrEqual(layerAt(r, k - 1, j));
    }
    // 周囲1セルは 0
    for (let c = 0; c < r.layerWidth; c++) expect(layerAt(r, r.fractions.length - 1, c)).toBe(0);
  });

  it('表層だけ: 置いた台数は表す台数より少なく、最終の段では全台が最終の位置にある', () => {
    const r = surface;
    expect(r.representedCount).toBe(120_000);
    expect(r.placedCount).toBeGreaterThan(1000);
    expect(r.placedCount).toBeLessThan(r.representedCount);
    for (let i = 1; i < r.arrivals.length; i++) expect(r.arrivals[i]!).toBeGreaterThanOrEqual(r.arrivals[i - 1]!);
    const K = r.fractions.length - 1;
    let level0 = 0;
    for (let i = 0; i < r.placedCount; i++) {
      expect(r.spacing[i]!).toBeGreaterThan(0.79);
      const th = layerAt(r, K, cellOf(r, i));
      const s = latticeState(r.pileHeight[i]!, r.spacing[i]!, r.maxLevel[i]!, th + 0.05);
      if (!s.hidden && s.level === 0) level0++;
    }
    // 中心が最終の表面の下にある自転車は段を下げない（双線形補間との差で端の数台はずれる）
    expect(level0 / r.placedCount).toBeGreaterThan(0.97);
  });

  it('表層だけ: 成長の途中でも、表面の下の表層に自転車がいる', () => {
    const r = surface;
    for (const t of [0.15, 0.4, 0.7]) {
      // セルごとに、見えている自転車の中心の深さ（鉛直）
      const covered = new Map<number, number>();
      for (let i = 0; i < r.placedCount; i++) {
        const j = cellOf(r, i);
        const th = thickAt(r, t, j);
        const s = latticeState(r.pileHeight[i]!, r.spacing[i]!, r.maxLevel[i]!, th);
        if (s.hidden) continue;
        expect(s.depth).toBeGreaterThanOrEqual(-1e-3);
        expect(s.depth).toBeLessThan(r.spacing[i]! + 1e-3);
        covered.set(j, (covered.get(j) ?? 0) + 1);
      }
      // 厚さが 2m 以上のセルの近く（3×3）には自転車がいる
      let cells = 0;
      let ok = 0;
      for (let row = 1; row < r.layerHeight - 1; row++) {
        for (let c = 1; c < r.layerWidth - 1; c++) {
          const j = row * r.layerWidth + c;
          if (thickAt(r, t, j) < 2) continue;
          cells++;
          let any = false;
          for (let dr = -1; dr <= 1 && !any; dr++) for (let dc = -1; dc <= 1 && !any; dc++) any = (covered.get(j + dr * r.layerWidth + dc) ?? 0) > 0;
          if (any) ok++;
        }
      }
      expect(cells).toBeGreaterThan(50);
      expect(ok / cells).toBeGreaterThan(0.97);
    }
  });

  it('降り直し: 遅れの表面が追いつくまでは前の段に置き、追いつく前の幅で落下する', () => {
    // 高さ 5m、間隔 1m の自転車。表面 3.2m（先頭）では 2 段下げる
    expect(latticeState(5, 1, 4, 3.2)).toMatchObject({ hidden: false, level: 2, fall: 1 });
    // 先頭が 4.1m（1段下げ）、遅れが 2.5m（3段下げ）。落下の幅 1m より遅れているので前の段（3段）に置く
    expect(latticeState(5, 1, 4, 4.1, 2.5)).toMatchObject({ level: 3, fall: 1 });
    // 遅れが 3.6m なら 1段下げの位置へ落下中（進み具合 0.6）
    const s = latticeState(5, 1, 4, 4.1, 3.6);
    expect(s.level).toBe(1);
    expect(s.fall).toBeCloseTo(0.6, 6);
    // 段数の上限より下（表面がまだ届いていない）は描かない
    expect(latticeState(5, 1, 2, 1.5).hidden).toBe(true);
    // 現れる前は、遅れが落下の幅に入るまで描かない
    expect(latticeState(5, 1, 2, 3.2, 1.0).hidden).toBe(true);
    expect(latticeState(5, 1, 2, 3.2, 2.5).hidden).toBe(false);
  });

  it('countAtMost と stageAt', () => {
    expect(countAtMost([0.1, 0.2, 0.2, 0.5], 0.2)).toBe(3);
    expect(countAtMost([0.1, 0.2], 0)).toBe(0);
    expect(stageAt([0, 0.5, 1], 0.75)).toEqual({ k: 1, a: 0.5 });
    expect(stageAt([0, 0.5, 1], 1)).toEqual({ k: 1, a: 1 });
  });
});

describe('山の場面の部品', () => {
  it('全台を詰める: 進み具合で表示台数が 0 から全台まで増え、表す台数と一致する', () => {
    const scene = createPileSceneFromResult(full, { reducedMotion: false });
    expect(scene.stats.shown).toBe(0);
    scene.setProgress(0.5);
    const half = scene.representedCount();
    expect(half).toBe(scene.field.getRevealCount(0));
    expect(half).toBeGreaterThan(30_000 * 0.4);
    expect(half).toBeLessThan(30_000 * 0.6);
    scene.setProgress(1);
    expect(scene.representedCount()).toBe(30_000);
    expect(scene.field.getRevealCount(0)).toBe(30_000);
    scene.setProgress(0.2);
    expect(scene.field.getRevealCount(0)).toBe(scene.representedCount(0.2));
    // 戻したときは空中に残さない
    expect(scene.field.getFallHead(0)).toBeLessThanOrEqual(scene.field.getRevealCount(0) + Math.round(30_000 * 0.012));
    scene.dispose();
  });

  it('表層だけ: 表す台数は進み具合 × 全台、置いた台数とは別に持つ', () => {
    const scene = createPileSceneFromResult(surface);
    scene.setProgress(0.25);
    expect(scene.representedCount()).toBe(30_000);
    expect(scene.info.placedCount).toBe(surface.placedCount);
    expect(scene.info.representedCount).toBe(120_000);
    scene.setProgress(1);
    expect(scene.field.getRevealCount(0)).toBe(surface.placedCount);
    scene.dispose();
  });
});

describe('animating', () => {
  it("'surface' は進み具合を上げると降り直しの途中になり、追いつくと終わる", async () => {
    const { PerspectiveCamera } = await import('three');
    const camera = new PerspectiveCamera(45, 16 / 9, 1, 5000);
    camera.position.set(0, 200, 400);
    camera.lookAt(0, 0, 0);
    const scene = createPileSceneFromResult(surface, { reducedMotion: false });
    scene.setProgress(0.2);
    scene.update(camera, 720);
    await new Promise((r) => setTimeout(r, 20));
    scene.update(camera, 720);
    expect(scene.animating).toBe(true);
    for (let k = 0; k < 400 && scene.animating; k++) {
      await new Promise((r) => setTimeout(r, 5));
      scene.update(camera, 720);
    }
    expect(scene.animating).toBe(false);
  });
});
