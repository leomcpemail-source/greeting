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
  'pink water lily flower bloom',   // เฉพาะ "lily flower bloom" ไม่ใช่ pond
  'sunflower yellow close up',
  'pink bougainvillea flower',
  'frangipani plumeria white flower',
  'yellow marigold flower macro',
  'red rose bloom close up',
  'white chrysanthemum flower',
  // ── ธรรมชาติ/ภูมิทัศน์ (ไม่มีสัตว์/คน) ──
  'morning mist mountain landscape',
  'green rice field aerial',
  'tropical leaves green background',
  'sakura cherry blossom tree',
  // ── สถานที่/วัด ──
  'thai buddhist temple golden',
  'chinese temple red lanterns',
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

export async function fetchStockPhoto(fetchT, ms = 45000) {
  if (!KEY) throw new Error('no PEXELS_API_KEY');
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const page = 1 + Math.floor(Math.random() * 8);
  const res = await fetchT(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=15&page=${page}&orientation=square`,
    { headers: { Authorization: KEY } }, ms);
  if (!res.ok) throw new Error('pexels http ' + res.status);
  const data = await res.json();
  // กรองรูปที่ alt/description มี keyword ไม่เหมาะ
  const list = (data.photos || []).filter(p => {
    if (!p || !p.src || !(p.src.large || p.src.original)) return false;
    const altLow = (p.alt || p.photographer_url || '').toLowerCase();
    const urlLow = (p.url || '').toLowerCase();
    return !BLOCKED_ALT_KEYWORDS.some(kw => altLow.includes(kw) || urlLow.includes(kw));
  });
  if (!list.length) throw new Error('no safe photos for ' + q);
  const p = list[Math.floor(Math.random() * list.length)];
  const imgUrl = p.src.large2x || p.src.large || p.src.original;
  const imgRes = await fetchT(imgUrl, {}, ms);
  if (!imgRes.ok) throw new Error('pexels img http ' + imgRes.status);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (buffer.length < 4000) throw new Error('photo too small');
  return { buffer, src: { name: q, by: p.photographer || 'Pexels', link: p.url || 'https://www.pexels.com' } };
}
