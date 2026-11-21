import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LANDMASK } from '../../src/geo/landmask';
import { latToTileY, lonToTileX } from '../../src/geo/tiles';
import { decodePng, encodePng1bit, erodeLand } from '../../scripts/data/build-landmask';

/** 1ビットのグレースケール PNG を、画素（1 が白）の配列に戻す。 */
function decodeGray1(buf: Buffer): { width: number; height: number; bits: Uint8Array } {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect(buf[24]).toBe(1);
  expect(buf[25]).toBe(0);
  const idat: Buffer[] = [];
  for (let pos = 8; pos < buf.length; ) {
    const len = buf.readUInt32BE(pos);
    if (buf.toString('latin1', pos + 4, pos + 8) === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = Math.ceil(width / 8);
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (rowBytes + 1)]).toBe(0);
    for (let x = 0; x < width; x++) bits[y * width + x] = (raw[y * (rowBytes + 1) + 1 + (x >> 3)]! >> (7 - (x & 7))) & 1;
  }
  return { width, height, bits };
}

describe('海陸マスクの作成（scripts/data/build-landmask.ts）', () => {
  it('1ビット PNG の書き出しが元の画素に戻る', () => {
    const w = 13;
    const h = 5;
    const bits = new Uint8Array(w * h).map((_, i) => ((i * 7) % 3 === 0 ? 1 : 0));
    const back = decodeGray1(encodePng1bit(w, h, bits));
    expect([back.width, back.height]).toEqual([w, h]);
    expect(Array.from(back.bits)).toEqual(Array.from(bits));
  });

  it('海に接する陸だけが海になる（4近傍）', () => {
    const w = 5;
    const h = 3;
    const sea = new Uint8Array(w * h);
    sea[1 * w + 0] = 1;
    const out = erodeLand(sea, w, h);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 0, /**/ 1, 1, 0, 0, 0, /**/ 1, 0, 0, 0, 0]);
  });

  it('PNG を復号できる（8ビット RGB、フィルタ 0〜4）', async () => {
    const { deflateSync, crc32 } = await import('node:zlib');
    const w = 3;
    const h = 3;
    const pix = [
      [10, 20, 30, 40, 50, 60, 70, 80, 90],
      [15, 25, 35, 45, 55, 65, 75, 85, 95],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    ];
    const bpp = 3;
    const filters = [1, 2, 4];
    const rows: number[] = [];
    pix.forEach((row, y) => {
      rows.push(filters[y]!);
      row.forEach((v, i) => {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = y > 0 ? pix[y - 1]![i]! : 0;
        const c = y > 0 && i >= bpp ? pix[y - 1]![i - bpp]! : 0;
        let pred = 0;
        if (filters[y] === 1) pred = a;
        else if (filters[y] === 2) pred = b;
        else if (filters[y] === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        rows.push((v - pred + 256) & 255);
      });
    });
    const chunk = (type: string, data: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'latin1');
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
      return Buffer.concat([head, data, tail]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const decoded = decodePng(png);
    expect([decoded.width, decoded.height]).toEqual([3, 3]);
    expect(Array.from(decoded.rgb)).toEqual(pix.flat());
  });
});

describe('public/data/basemap/landmask.png', () => {
  const file = readFileSync(resolve(__dirname, '../../public', LANDMASK.path));
  const mask = decodeGray1(file);
  const isSea = (lat: number, lon: number): boolean => {
    const px = Math.floor((lonToTileX(lon, LANDMASK.z) - LANDMASK.x0) * LANDMASK.tileSize);
    const py = Math.floor((latToTileY(lat, LANDMASK.z) - LANDMASK.y0) * LANDMASK.tileSize);
    expect(px).toBeGreaterThanOrEqual(0);
    expect(py).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThan(mask.width);
    expect(py).toBeLessThan(mask.height);
    return mask.bits[py * mask.width + px] === 1;
  };

  it('範囲の大きさがタイルの数と合っている', () => {
    expect(mask.width).toBe(LANDMASK.tilesX * LANDMASK.tileSize);
    expect(mask.height).toBe(LANDMASK.tilesY * LANDMASK.tileSize);
  });

  it('東京湾・相模湾・太平洋は海、都心・秩父・房総の内陸は陸', () => {
    expect(isSea(35.55, 139.85)).toBe(true); // 東京湾の中央（羽田沖）
    expect(isSea(35.2, 139.55)).toBe(true); // 相模湾
    expect(isSea(34.6, 140.5)).toBe(true); // 太平洋
    expect(isSea(35.68124, 139.76712)).toBe(false); // 東京駅
    expect(isSea(35.9, 139.2)).toBe(false); // 秩父
    expect(isSea(35.4, 140.1)).toBe(false); // 房総半島の内陸
    expect(isSea(35.45, 139.45)).toBe(false); // 神奈川の内陸
  });
});
