// png.mjs — PNG の最小限の読み書き（依存なし）。
// 目的: ストア掲載画像が「24bit RGB・アルファ無し」であることを IHDR から直接検査し、
//       Chrome が出力する RGBA の PNG を RGB（カラータイプ 2）へ変換する。
// 制約: 変換対象は 8bit・非インターレースの RGB / RGBA のみ。それ以外は黙って変換せず例外にする。
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32（PNG チャンク用）。表は初回に作る。 */
let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** チャンクを列挙する。署名が不正なら例外。 */
export function readChunks(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("PNG ではありません");
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** IHDR を読む。colorType 2 = RGB（アルファ無し）、6 = RGBA。 */
export function inspectPng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) throw new Error("IHDR がありません");
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    interlace: ihdr.data[12],
    hasTransparencyChunk: chunks.some((chunk) => chunk.type === "tRNS"),
  };
}

function makeChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** フィルタを戻して生のピクセル行にする。 */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[dst - stride + x - bpp] : 0;
      let value = raw[src + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`未対応の PNG フィルタ ${filter}`);
      out[dst + x] = value & 0xff;
    }
  }
  return out;
}

/**
 * 8bit の RGB / RGBA PNG を、アルファ無しの RGB（カラータイプ 2）へ変換する。
 * RGBA は不透明（alpha=255）でなければ例外にする（透過を黙って黒へ落とさない）。
 * 既に RGB（tRNS 無し）ならそのまま返す。
 */
export function toRgb24(buffer) {
  const info = inspectPng(buffer);
  if (info.bitDepth !== 8 || info.interlace !== 0) throw new Error("8bit・非インターレース以外の PNG は変換できません");
  if (info.colorType === 2 && !info.hasTransparencyChunk) return buffer;
  if (info.colorType !== 6 && info.colorType !== 2) throw new Error(`未対応のカラータイプ ${info.colorType}`);
  const bpp = info.colorType === 6 ? 4 : 3;
  const idat = Buffer.concat(readChunks(buffer).filter((c) => c.type === "IDAT").map((c) => c.data));
  const pixels = unfilter(zlib.inflateSync(idat), info.width, info.height, bpp);
  const stride = info.width * 3;
  const rows = Buffer.alloc((stride + 1) * info.height);
  for (let y = 0; y < info.height; y++) {
    const rowStart = y * (stride + 1);
    rows[rowStart] = 1; // Sub フィルタ（実装が単純で、ガラス調のなだらかな面とも相性がよい）
    for (let x = 0; x < info.width; x++) {
      const p = (y * info.width + x) * bpp;
      if (bpp === 4 && pixels[p + 3] !== 255) throw new Error("透過ピクセルがあるため RGB へ変換できません");
      for (let c = 0; c < 3; c++) {
        const here = pixels[p + c];
        const left = x > 0 ? pixels[p - bpp + c] : 0;
        rows[rowStart + 1 + x * 3 + c] = (here - left) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(info.width, 0);
  ihdr.writeUInt32BE(info.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIGNATURE, makeChunk("IHDR", ihdr), makeChunk("IDAT", zlib.deflateSync(rows, { level: 9 })), makeChunk("IEND", Buffer.alloc(0))]);
}

/** JPEG の寸法を SOF から読む（verify 用。`--format jpeg` 時）。 */
export function inspectJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("JPEG ではありません");
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error("JPEG のマーカーが不正です");
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), components: buffer[offset + 9] };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG の SOF が見つかりません");
}
