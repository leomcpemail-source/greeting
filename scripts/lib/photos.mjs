// scripts/lib/photos.mjs
// แหล่งรูป "ถ่ายจริง royalty-free" (Pexels) สำหรับ ดอกไม้/ต้นไม้/สถานที่ — ไม่เอาคน
// ใช้ก็ต่อเมื่อมี env PEXELS_API_KEY ; ถ้าไม่มี = ปิด (pipeline ใช้ Pollinations ล้วนตามเดิม)
// แสดงเครดิตแหล่งที่มาผ่านปุ่ม "i" ในเว็บ (Pexels ใช้ฟรี ไม่บังคับเครดิต แต่ควรให้)
//
// คืน { buffer, src } โดย src = { name, by, link } (ชื่อดอกไม้/หัวข้อ, ช่างภาพ, ลิงก์ต้นทาง)

const KEY = process.env.PEXELS_API_KEY || '';
export const photosEnabled = () => !!KEY;

// คิวรีที่ "ไม่มีคน" (ดอกไม้/ธรรมชาติ/สถานที่) — ตรงรสนิยมการ์ดสวัสดีผู้ใหญ่ไทย
const QUERIES = [
  'lotus flower close up', 'white jasmine flower', 'marigold flowers',
  'pink cherry blossom', 'orchid flower macro', 'water lily pond',
  'green rice field thailand', 'thai temple architecture', 'tropical flower garden',
  'sunflower field morning light', 'pink bougainvillea', 'frangipani plumeria flower',
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
  const list = (data.photos || []).filter(p => p && p.src && (p.src.large || p.src.original));
  if (!list.length) throw new Error('no photos for ' + q);
  const p = list[Math.floor(Math.random() * list.length)];
  const imgUrl = p.src.large2x || p.src.large || p.src.original;
  const imgRes = await fetchT(imgUrl, {}, ms);
  if (!imgRes.ok) throw new Error('pexels img http ' + imgRes.status);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (buffer.length < 4000) throw new Error('photo too small');
  return { buffer, src: { name: q, by: p.photographer || 'Pexels', link: p.url || 'https://www.pexels.com' } };
}
