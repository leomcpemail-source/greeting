// scripts/lib/photos.mjs
// แหล่งรูป "ถ่ายจริง royalty-free" (Pexels) สำหรับ ดอกไม้/ต้นไม้/สถานที่ — ไม่เอาคน
// ใช้ก็ต่อเมื่อมี env PEXELS_API_KEY ; ถ้าไม่มี = ปิด (pipeline ใช้ Pollinations ล้วนตามเดิม)
// แสดงเครดิตแหล่งที่มาผ่านปุ่ม "i" ในเว็บ (Pexels ใช้ฟรี ไม่บังคับเครดิต แต่ควรให้)
//
// คืน { buffer, src } โดย src = { name, by, link } (ชื่อดอกไม้/หัวข้อ, ช่างภาพ, ลิงก์ต้นทาง)

const KEY = process.env.PEXELS_API_KEY || '';
export const photosEnabled = () => !!KEY;

// คิวรีที่ "ไม่มีคน" (ดอกไม้/ธรรมชาติ/สถานที่) — ตรงรสนิยมการ์ดสวัสดีผู้ใหญ่ไทย
// ⚠️ หลักการตั้ง keyword: ต้องเฉพาะเจาะจงมากพอที่ Pexels จะคืนรูปในหมวดนั้นจริงๆ
//    keyword กว้างเกินไป (เช่น 'water lily pond') มักได้รูปสัตว์/คนมาด้วย
//    ใช้รูปแบบ "<ชื่อดอกไม้หรือสิ่งของ> close up macro" หรือ "<สถานที่> architecture" แทน
const QUERIES = [
  // ── ดอกไม้ (เฉพาะเจาะจง ไม่ให้ได้สัตว์/คน) ──
  'lotus flower close up macro',
  'white jasmine flower bloom',
  'marigold orange flower macro',
  'pink cherry blossom branch',
  'orchid purple flower macro',
  'sunflower yellow close up',
  'frangipani plumeria white flower',
  'red rose bloom close up',
  'yellow chrysanthemum flower macro',
  'pink peony bloom close up',
  'blue morning glory flower',
  'purple lavender field macro',
  // ── ธรรมชาติ/ภูมิทัศน์ (ไม่มีสัตว์/คน) ──
  'morning mist mountain landscape',
  'green rice field sunrise',
  'tropical beach turquoise sea',
  'waterfall in green forest',
  'misty mountain layers dawn',
  'golden sky sunset clouds',
  'zen garden stones water',
  'autumn maple leaves red',
  // ── วัด/พระพุทธรูป/สถานที่ศักดิ์สิทธิ์ (เพิ่มมากขึ้น) ──
  'thai buddhist temple golden',
  'chinese temple red lanterns',
  'thai temple roof ornate',
  'pagoda misty mountain',
  'golden buddhist pagoda stupa',
  'thai temple spire golden sky',
  'white stupa pagoda sunrise',
  'ancient thai temple architecture',
  // ── มงคล/พระ/ของไหว้ ──
  'gold buddha statue serene',
  'incense candle temple offering',
  'lotus flower temple offering',
  'golden buddha lotus pedestal',
];

// keyword ที่ห้ามมีในชื่อไฟล์/alt text ของรูป Pexels (กรองรูปไม่เหมาะ)
// Pexels คืน field 'alt' ซึ่งมักตรงกับเนื้อหารูปจริง
const BLOCKED_ALT_KEYWORDS = [
  'crocodile', 'alligator', 'snake', 'shark', 'spider', 'scorpion',
  'skull', 'skeleton', 'cemetery', 'funeral', 'coffin', 'dead',
  'gun', 'weapon', 'blood', 'wound', 'accident', 'crash',
  'nude', 'naked', 'bikini', 'lingerie',
  'wedding dress', 'bride', 'groom',   // รูปคน ไม่เหมาะการ์ดสวัสดี
  'portrait', 'face close', 'selfie',
  'flamingo', 'crocodilian',
  'bird nest', 'eagle', 'vulture', 'bat',
  'white bed', 'hotel room', 'bathroom', 'bedroom',
  'mosque', 'church', 'cross',  // ศาสนาอื่น ไม่เหมาะ
];

// แปลงคำบรรยายดอกไม้ประจำวัน (theme.flower) → query Pexels ที่เน้นดอกไม้ + โทนสี
// เช่น 'blue morning glory and forget-me-nots' → ['blue morning glory flower','forget-me-nots blue flower']
export function dayFlowerQueries(flowerDesc, tone) {
  if (!flowerDesc) return [];
  // ตัด 'and' แยกเป็นดอกไม้แต่ละชนิด + เติมคำว่า flower เพื่อบังคับ Pexels ให้ได้ดอกไม้
  const parts = String(flowerDesc).split(/\s+and\s+|,/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    out.push(`${p} flower close up`);
    out.push(`${p} bloom macro`);
  }
  // เติม query โทนสีรวม เผื่อดอกไม้เฉพาะหาไม่เจอ
  if (tone) out.push(`${tone} flowers macro no people`);
  return out;
}

// cache ผลค้นหาต่อ query — 1 search ได้ ~15 รูป ใช้ทีละรูปจนหมดค่อยค้นหน้าใหม่
// จำเป็นเมื่อเติมรูปจำนวนมาก/วัน (30 รูป × 12 หมวด): ลด search call ~10 เท่า
// กันชน rate limit Pexels (200 req/ชม., 20k/เดือน)
const _searchCache = new Map();  // query -> photo[] (ที่ยังไม่ถูกใช้)

// fetchT: fetch helper, ms: timeout, preferQueries: query list ตามสีวัน (ถ้ามีจะสุ่มจากชุดนี้ก่อน)
// opts.strict = true: ใช้เฉพาะ preferQueries เท่านั้น (ไม่ fallback ไป QUERIES กลาง) — สำหรับรูปเจาะหมวด
//   ที่ต้องได้รูปตรงหมวดเป๊ะ ถ้าหาไม่เจอจะ throw เพื่อให้ผู้เรียกตก AI gen แทนการได้รูปผิดหมวด
export async function fetchStockPhoto(fetchT, ms = 45000, preferQueries = null, opts = {}) {
  if (!KEY) throw new Error('no PEXELS_API_KEY');
  const strict = !!opts.strict;
  // ถ้ามี preferQueries (สีดอกไม้วัน) ใช้ก่อน 55% เพื่อให้โทนสีตรงวัน; ที่เหลือสุ่มจาก QUERIES กลาง
  // strict: บังคับใช้ preferQueries เสมอ (รูปเจาะหมวดต้องตรงหมวด ห้ามปน QUERIES กลาง)
  const usePrefer = preferQueries && preferQueries.length && (strict || Math.random() < 0.55);
  const pool = usePrefer ? preferQueries : QUERIES;
  const q = pool[Math.floor(Math.random() * pool.length)];

  let list = _searchCache.get(q);
  if (!list || !list.length) {
    const page = 1 + Math.floor(Math.random() * 8);
    const res = await fetchT(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=15&page=${page}&orientation=square`,
      { headers: { Authorization: KEY } }, ms);
    if (!res.ok) throw new Error('pexels http ' + res.status);
    const data = await res.json();
    // กรองรูปที่ alt/description มี keyword ไม่เหมาะ
    list = (data.photos || []).filter(p => {
      if (!p || !p.src || !(p.src.large || p.src.original)) return false;
      const altLow = (p.alt || p.photographer_url || '').toLowerCase();
      const urlLow = (p.url || '').toLowerCase();
      return !BLOCKED_ALT_KEYWORDS.some(kw => altLow.includes(kw) || urlLow.includes(kw));
    });
    // สลับลำดับ ให้การหยิบทีละรูปไม่เรียงตาม popularity เป๊ะ
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    _searchCache.set(q, list);
  }
  if (!list.length) { _searchCache.delete(q); throw new Error('no safe photos for ' + q); }
  const p = list.pop();  // ใช้แล้วตัดออก — เรียกครั้งถัดไปได้รูปอื่นจากผลค้นเดิม
  const imgUrl = p.src.large2x || p.src.large || p.src.original;
  const imgRes = await fetchT(imgUrl, {}, ms);
  if (!imgRes.ok) throw new Error('pexels img http ' + imgRes.status);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (buffer.length < 4000) throw new Error('photo too small');
  return { buffer, src: { name: q, by: p.photographer || 'Pexels', link: p.url || 'https://www.pexels.com' } };
}
