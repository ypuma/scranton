import fs from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const size = 1024;
const pixels = Buffer.alloc(size * (1 + size * 4));
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const p = y * (size * 4 + 1) + 1 + x * 4;
    const dx = Math.max(112 - x, 0, x - 911);
    const dy = Math.max(112 - y, 0, y - 911);
    const inside = dx * dx + dy * dy <= 112 * 112;
    const mark = (x >= 242 && x < 782 && ((y >= 240 && y < 360) || (y >= 452 && y < 572) || (y >= 664 && y < 784)))
      || (x >= 242 && x < 362 && y >= 360 && y < 452)
      || (x >= 662 && x < 782 && y >= 572 && y < 664);
    pixels[p] = pixels[p + 1] = pixels[p + 2] = mark ? 242 : 11;
    pixels[p + 3] = inside ? 255 : 0;
  }
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
header[8] = 8; header[9] = 6;
await fs.mkdir(new URL('../src-tauri/icons/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../src-tauri/icons/source.png', import.meta.url), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
]));
console.log('Generated monochrome 1024 × 1024 icon.');
