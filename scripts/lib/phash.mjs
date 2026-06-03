// lib/phash.mjs
// Perceptual hash (dHash) + Hamming distance สำหรับกัน "รูปคล้าย/ซ้ำ"
// ใช้ "ก่อน" composite + rubric เพื่อประหยัด Puppeteer และโควตา AI
// ไม่ใช้ AI เลย -> เร็ว ถูก deterministic
//
// ต้องมี dependency: jpeg-js (โปรเจกต์มีอยู่แล้ว)
import jpeg from "jpeg-js";

const W = 9, H = 8; // dHash: เทียบ 9x8 -> ได้ 8x8 = 64 บิต

function decodeRGBA(jpegBuffer) {
  // formatAsRGBA: true -> data เป็น Uint8 [r,g,b,a, r,g,b,a, ...]
  return jpeg.decode(jpegBuffer, { useTArray: true, formatAsRGBA: true });
}

// ย่อภาพแบบ nearest-neighbour + แปลงเป็น grayscale -> ตาราง luminance ขนาด WxH
function grayGrid(jpegBuffer) {
  const { data, width, height } = decodeRGBA(jpegBuffer);
  const grid = new Float64Array(W * H);
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const sx = Math.min(width - 1, Math.floor((gx + 0.5) * width / W));
      const sy = Math.min(height - 1, Math.floor((gy + 0.5) * height / H));
      const i = (sy * width + sx) * 4;
      grid[gy * W + gx] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return grid;
}

// คืนค่า hash 64 บิตเป็น BigInt
export function dhash(jpegBuffer) {
  const g = grayGrid(jpegBuffer);
  let hash = 0n, bit = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (g[y * W + x] > g[y * W + x + 1]) hash |= (1n << bit);
      bit++;
    }
  }
  return hash; // 64-bit
}

export function hamming(a, b) {
  let x = BigInt(a) ^ BigInt(b), count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

// true ถ้า candidateHash ใกล้กับ hash ใดในชุดเดิมเกิน threshold (ยิ่งน้อยยิ่งเข้มงวด)
// threshold ~6/64 = จับรูปคล้ายได้ดี ปรับได้ตามผลจริง
export function isDuplicate(candidateHash, existingHashes, threshold = 6) {
  for (const h of existingHashes) {
    if (hamming(candidateHash, h) <= threshold) return true;
  }
  return false;
}

// BigInt -> string สำหรับเก็บใน manifest JSON
export const hashToStr = (h) => h.toString();
