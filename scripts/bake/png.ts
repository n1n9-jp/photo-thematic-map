/** 8bit の RGB / RGBA（インターレースなし）の PNG を復号する。国土地理院の標高タイル用。 */
import { inflateSync } from 'node:zlib';

export interface RgbImage {
  width: number;
  height: number;
  /** 画素あたりのチャンネル数（3 または 4）。 */
  channels: number;
  data: Uint8Array;
}

export function decodePng(buf: Uint8Array): RgbImage {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  sig.forEach((v, i) => {
    if (buf[i] !== v) throw new Error('PNG ではありません');
  });
  let o = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (o < buf.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = v.getUint32(0);
      height = v.getUint32(4);
      const depth = body[8];
      colorType = body[9] as number;
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) {
        throw new Error(`未対応の PNG です（bit depth ${depth}, color type ${colorType}, interlace ${body[12]}）`);
      }
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (out[dst + x - channels] as number) : 0;
      const b = y > 0 ? (out[dst - stride + x] as number) : 0;
      const c = x >= channels && y > 0 ? (out[dst - stride + x - channels] as number) : 0;
      const v = raw[src + x] as number;
      let p: number;
      switch (f) {
        case 0: p = v; break;
        case 1: p = v + a; break;
        case 2: p = v + b; break;
        case 3: p = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`未対応の PNG フィルタ ${f}`);
      }
      out[dst + x] = p & 0xff;
    }
  }
  return { width, height, channels, data: out };
}
