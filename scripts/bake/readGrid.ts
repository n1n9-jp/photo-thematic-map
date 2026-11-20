/** public/data/grids/ の格子をファイルから読む（Node 用。テストと堆積計算の試しで使う）。 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cityGridFromBytes, gridMetaPath, type CityGrid, type GridMeta, type GridBytes } from '../../src/data/grids';

const PUBLIC = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'public');

export function readGridFiles(name: string): { meta: GridMeta; bytes: GridBytes } {
  const meta = JSON.parse(readFileSync(join(PUBLIC, gridMetaPath(name)), 'utf8')) as GridMeta;
  const rd = (p: string): Uint8Array => new Uint8Array(readFileSync(join(PUBLIC, p)));
  return { meta, bytes: { height: rd(meta.files.height.path), ground: rd(meta.files.ground.path), classes: rd(meta.files.class.path) } };
}

export function readCityGrid(name: string): CityGrid {
  const { meta, bytes } = readGridFiles(name);
  return cityGridFromBytes(meta, bytes);
}
