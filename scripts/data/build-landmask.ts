/**
 * 国土地理院の標高タイル（dem_png、ズーム9）の無効値（海）から、海陸マスクの PNG（1ビットのグレースケール）を作り、
 * public/data/basemap/landmask.png に書き出す。範囲は src/geo/landmask.ts。
 *
 * 実行: npm run data:landmask（Node 22 の型除去で .ts を直接実行する）
 *
 * - 標高タイルが存在しない（404）タイルは、すべて海とみなす。
 * - 標高が無効値（R=128, G=0, B=0）の画素を海（1）、有効値の画素を陸（0）とする。
 * - 海に接する陸の画素（4近傍）は海にする。地面（`src/scene/plateau/ground.ts`）は海（標高の無効値）の上が透明で、
 *   その下に海の色が見えるので、マスクの粗さ（約 250m）のぶんだけ、海岸線の外側に陸の色の縁が出ないようにするため。
 * 出典: 国土地理院 標高タイル https://maps.gsi.go.jp/development/demtile.html
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { LANDMASK } from '../../src/geo/landmask';

const DEM_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../public', LANDMASK.path);

/** PNG（8ビット、RGB または RGBA、インターレースなし）を RGB の画素列に復号する。 */
export function decodePng(buf: Buffer): { width: number; height: number; rgb: Uint8Array } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG ではありません');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`未対応の PNG です（depth=${depth}, colorType=${colorType}, interlace=${interlace}）`);
      }
      channels = colorType === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] ?? 0;
      const a = i >= channels ? (out[y * stride + i - channels] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= channels ? (out[(y - 1) * stride + i - channels] ?? 0) : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + i] = v & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = out[i * channels] ?? 0;
    rgb[i * 3 + 1] = out[i * channels + 1] ?? 0;
    rgb[i * 3 + 2] = out[i * channels + 2] ?? 0;
  }
  return { width, height, rgb };
}

/** 1ビットのグレースケール PNG（1 が白）。 */
export function encodePng1bit(width: number, height: number, bits: Uint8Array): Buffer {
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) raw[y * (rowBytes + 1) + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // 1 ビット
  ihdr[9] = 0; // グレースケール
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 海に接する陸（4近傍）を海にする。 */
export function erodeLand(sea: Uint8Array, width: number, height: number): Uint8Array {
  const out = Uint8Array.from(sea);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (sea[y * width + x]) continue;
      const near =
        (x > 0 && sea[y * width + x - 1]) ||
        (x < width - 1 && sea[y * width + x + 1]) ||
        (y > 0 && sea[(y - 1) * width + x]) ||
        (y < height - 1 && sea[(y + 1) * width + x]);
      if (near) out[y * width + x] = 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { z, x0, y0, tilesX, tilesY, tileSize } = LANDMASK;
  const width = tilesX * tileSize;
  const height = tilesY * tileSize;
  const sea = new Uint8Array(width * height);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const url = DEM_URL.replace('{z}', String(z)).replace('{x}', String(x0 + tx)).replace('{y}', String(y0 + ty));
      const res = await fetch(url);
      let seaPixels = tileSize * tileSize;
      if (res.ok) {
        const { width: w, rgb } = decodePng(Buffer.from(await res.arrayBuffer()));
        if (w !== tileSize) throw new Error(`${url}: 想定外の大きさ ${w}`);
        seaPixels = 0;
        for (let py = 0; py < tileSize; py++) {
          for (let px = 0; px < tileSize; px++) {
            const k = (py * tileSize + px) * 3;
            const invalid = rgb[k] === 128 && rgb[k + 1] === 0 && rgb[k + 2] === 0;
            sea[(ty * tileSize + py) * width + tx * tileSize + px] = invalid ? 1 : 0;
            if (invalid) seaPixels++;
          }
        }
      } else if (res.status === 404) {
        for (let py = 0; py < tileSize; py++) sea.fill(1, (ty * tileSize + py) * width + tx * tileSize, (ty * tileSize + py) * width + (tx + 1) * tileSize);
      } else {
        throw new Error(`${url}: HTTP ${res.status}`);
      }
      console.log(`${z}/${x0 + tx}/${y0 + ty}: 海 ${((seaPixels / (tileSize * tileSize)) * 100).toFixed(0)}%`);
    }
  }
  const mask = erodeLand(sea, width, height);
  const png = encodePng1bit(width, height, mask);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, png);
  console.log(`${OUT}: ${width}×${height}, ${png.length} バイト`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
