import { PerspectiveCamera, type DataTexture } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BicycleField } from '../../src/scene/bicycle/field';
import { heapOnSurface, moundHeight, parkedRows } from '../../src/scene/bicycle/layouts';

const pileOpts = { seed: 1, count: 5000, height: moundHeight({ x: 0, z: 0 }, 20, 8), bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } };

/** まとまりのパラメータのテクスチャ（テクセル0: T, A, W, 高さ。テクセル1: 表面の扱い…）。 */
function groupTexels(field: BicycleField, slot: number): number[] {
  const tex = (field as unknown as { uniforms: { uReveal: { value: DataTexture } } }).uniforms.uReveal.value;
  const data = tex.image.data as Float32Array;
  return Array.from(data.subarray(slot * 8, slot * 8 + 8));
}

function setup(): { field: BicycleField; camera: PerspectiveCamera; pile: number; row: number } {
  const field = new BicycleField();
  const pile = field.addGroup(heapOnSurface(pileOpts), { reveal: 0, fall: { height: 40, window: 500 } });
  const row = field.addGroup(parkedRows({ seed: 2, count: 300, start: { x: -40, z: 30 } }));
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 3000);
  camera.position.set(60, 40, 90);
  camera.lookAt(0, 0, 0);
  field.update(camera, 720);
  return { field, camera, pile, row };
}

describe('BicycleField: 降ってくる動き', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('落下なしのまとまりは従来どおり（表示台数だけ、落下の幅 0）', () => {
    const { field, camera, row } = setup();
    field.setRevealCount(120, row);
    field.update(camera, 720);
    expect(groupTexels(field, row).slice(0, 4)).toEqual([120, 120, 0, 0]);
    expect(groupTexels(field, row)[4]).toBe(0);
    expect(field.getLandedCount(row)).toBe(120);
  });

  it('表示台数を増やすと、落下の先頭が時間で追いつき、止まると空中に残らない', () => {
    const { field, camera, pile } = setup();
    expect(field.getFallHead(pile)).toBe(500);
    field.setRevealCount(3000, pile);
    field.update(camera, 720);
    // 時間が進んでいないので、まだ先頭は動かない
    expect(field.getFallHead(pile)).toBe(500);
    expect(field.getLandedCount(pile)).toBe(0);
    const heads: number[] = [];
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(50);
      field.update(camera, 720);
      heads.push(field.getFallHead(pile));
    }
    for (let i = 1; i < heads.length; i++) expect(heads[i]!).toBeGreaterThanOrEqual(heads[i - 1]!);
    // 2 秒後には全台が着地している（先頭 = 表示台数 + 幅）
    expect(field.getFallHead(pile)).toBe(3500);
    expect(field.getLandedCount(pile)).toBe(3000);
    expect(field.stats.falling).toBe(0);
    const tx = groupTexels(field, pile);
    expect(tx.slice(0, 4)).toEqual([3000, 3500, 500, 40]);
    // 着地した後は転送しない
    vi.advanceTimersByTime(50);
    field.update(camera, 720);
    expect(field.stats.frameUploadBytes).toBe(0);
  });

  it('一気に進めても、先頭は少しずつ進み、落下中の台数は幅を超えない', () => {
    const { field, camera, pile } = setup();
    field.setRevealCount(5000, pile);
    let maxFalling = 0;
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(16);
      field.update(camera, 720);
      maxFalling = Math.max(maxFalling, field.stats.falling);
      expect(field.stats.frameUploadBytes).toBeLessThanOrEqual(64);
    }
    expect(maxFalling).toBeGreaterThan(0);
    expect(maxFalling).toBeLessThanOrEqual(500);
    expect(field.getFallHead(pile)).toBeLessThan(5500);
  });

  it('戻すと（逆スクロール）、先頭は 表示台数 + 幅 まで下がり、空中に残らない', () => {
    const { field, camera, pile } = setup();
    field.setRevealCount(4000, pile);
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(50);
      field.update(camera, 720);
    }
    expect(field.getLandedCount(pile)).toBe(4000);
    field.setRevealCount(1000, pile);
    field.update(camera, 720);
    expect(field.getFallHead(pile)).toBe(1500);
    expect(field.getLandedCount(pile)).toBe(1000);
    expect(field.stats.falling).toBe(0);
  });

  it('止めている間は進まず、lead で「スクロールの途中」の状態にできる', () => {
    const { field, camera, pile } = setup();
    field.pauseFalls = true;
    field.setRevealCount(2000, pile, { lead: 0 });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(50);
      field.update(camera, 720);
    }
    expect(field.getFallHead(pile)).toBe(2000);
    expect(field.getLandedCount(pile)).toBe(1500);
    expect(field.stats.falling).toBe(500);
    field.pauseFalls = false;
    vi.advanceTimersByTime(50);
    field.update(camera, 720);
    expect(field.getFallHead(pile)).toBeGreaterThan(2000);
  });

  it('動きを減らす設定では落下を省く', () => {
    const { field, camera, pile } = setup();
    field.reducedMotion = true;
    field.setRevealCount(2500, pile);
    field.update(camera, 720);
    expect(field.getLandedCount(pile)).toBe(2500);
    expect(field.stats.falling).toBe(0);
    expect(groupTexels(field, pile).slice(0, 3)).toEqual([2500, 2500, 0]);
  });

  it('落下の高さぶん、視錐台の判定の範囲を上へ広げる', () => {
    const field = new BicycleField();
    field.addGroup(heapOnSurface(pileOpts), { reveal: 0, fall: { height: 40, window: 500 } });
    const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 3000);
    // 山の真上 60m から上だけを見る（自転車の最終の位置は視野の外、落下の範囲は中）
    camera.position.set(0, 30, 80);
    camera.lookAt(0, 45, 0);
    field.setRevealCount(5000);
    field.update(camera, 720);
    expect(field.stats.visible).toBeGreaterThan(0);
  });
});
