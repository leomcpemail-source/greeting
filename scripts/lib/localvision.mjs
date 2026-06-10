// scripts/lib/localvision.mjs
// AI local: CLIP open-source (zero-shot) รันบนเครื่อง runner เอง — ฟรี ไม่มีโควตา
// ใช้เป็น "ด่านตรวจเนื้อหาชั้นสุดท้าย" ของ photo-trust เมื่อ AI cloud ล่มหมด
// กฎเหล็ก: ห้าม throw เด็ดขาด — error ใด ๆ คืน null ให้ caller fallback พฤติกรรมเดิม

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_VISION_BAD_CONF = Number(process.env.LOCAL_VISION_BAD_CONF || 0.45);

// label ที่ไม่เหมาะกับการ์ดอวยพรผู้สูงอายุไทย (เคยหลุด: จระเข้/เจ้าสาว)
const BAD_LABELS = [
  'a crocodile or alligator',
  'a snake',
  'a closeup of a spider',
  'a bride in a wedding dress',
  'a person in revealing clothing',
  'a weapon',
  'blood or a scary scene',
  'a dark horror scene',
  'a mosque',
  'garbage or trash',
  'a dead animal',
];

// label เนื้อหาปกติของการ์ด — ให้ CLIP มีตัวเลือกฝั่งดีเทียบ (กัน false positive)
const GOOD_LABELS = [
  'beautiful flowers',
  'a buddhist temple, buddha statue or pagoda',
  'a nature landscape',
  'coffee or a breakfast meal',
  'a cute pet',
  'a family silhouette',
  'candles or incense sticks',
  'fresh fruit',
  'a greeting card with text',
];

let pipePromise = null;  // โหลด pipeline ครั้งเดียวต่อ process (lazy singleton)
let broken = false;      // โหลดล้มแล้ว = จำไว้ ไม่ลองซ้ำ (กันเสียเวลาทุกใบ)

async function getPipe() {
  if (broken) return null;
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.HF_CACHE_DIR || './.hf-cache';
      return pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', { dtype: 'q8' });
    })().catch((e) => {
      broken = true;
      console.log(`  ! localvision: โหลดโมเดลไม่สำเร็จ (${e.message}) — ปิดด่าน local รอบนี้`);
      return null;
    });
  }
  return pipePromise;
}

// รับ Buffer jpeg → {ok,label,conf} หรือ null เมื่อตรวจไม่ได้ (caller ใช้พฤติกรรมเดิม)
export async function localContentCheck(buf) {
  try {
    const pipe = await getPipe();
    if (!pipe) return null;
    const tmp = path.join(os.tmpdir(), `lv_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try {
      fs.writeFileSync(tmp, buf);
      const res = await pipe(tmp, [...BAD_LABELS, ...GOOD_LABELS]);
      const list = Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : null;
      const top = list && list[0];
      if (!top || typeof top.score !== 'number') return null;
      const bad = BAD_LABELS.includes(top.label) && top.score >= LOCAL_VISION_BAD_CONF;
      return { ok: !bad, label: top.label, conf: top.score };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch (e) {
    return null;
  }
}

// โหมดทดสอบ: node scripts/lib/localvision.mjs <รูป.jpg>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = process.argv[2];
  if (!f) { console.log('ใช้: node scripts/lib/localvision.mjs <รูป.jpg>'); process.exit(1); }
  const r = await localContentCheck(fs.readFileSync(f));
  console.log(r);
}
