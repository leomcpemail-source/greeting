// scripts/line_richmenu.mjs
// ติดตั้ง Rich Menu ของ LINE Official Account ให้เหมือนเมนูในเว็บแอพ
// *** ไม่สร้างรูปให้ *** — คุณเตรียมรูปเอง 2 ไฟล์ (ดูสเปกเลย์เอาต์ด้านล่าง / ใน LINE_SETUP.md)
// สคริปต์นี้แค่ลงทะเบียนเมนู + ผูกช่องกด (area) + สลับเมนู + ตั้งเป็น default
//
// โครงเมนู 2 ระดับ (ใช้ฟีเจอร์ rich menu switch ของ LINE):
//   เมนูหลัก (greeting-main)        : 2 ช่อง  →  "หน้าแรก" | "ตามหมวด"
//       • หน้าแรก  → เปิดเว็บแอพหน้าแรก
//       • ตามหมวด  → สลับไปเมนูย่อยหมวดหมู่
//   เมนูย่อย (greeting-categories)  : "‹ กลับ" (แถบบน) + 12 หมวด (กริด 4×3)
//       • แต่ละหมวด → เปิดเว็บแอพ deep-link ?cat=<id> เข้าหมวดนั้นเลย
//       • ‹ กลับ   → สลับกลับเมนูหลัก
//
// ───────────── สเปกรูป (ทำให้ตรงเป๊ะ ไม่งั้นช่องกดจะเลื่อน) ─────────────
//   ขนาดทั้งสองรูป: 2500 × 1686 px, PNG หรือ JPEG, ไฟล์ ≤ 1 MB
//
//   รูปเมนูหลัก (main):  แบ่งซ้าย-ขวาที่ x = 1250
//       ซ้าย  (0..1250)      = "หน้าแรก"
//       ขวา   (1250..2500)   = "ตามหมวด"
//
//   รูปเมนูหมวด (categories):
//       แถบบน (y 0..230, เต็มกว้าง) = ปุ่ม "‹ กลับ"
//       ด้านล่างเป็นกริด 4 คอลัมน์ × 3 แถว (คอลัมน์กว้าง 625, แถวสูง 485)
//       ไล่หมวดซ้าย→ขวา บน→ล่าง ตามลำดับนี้:
//         แถว1: ดอกไม้ | ธรรมะ | กำลังใจ | คิดถึง
//         แถว2: วันเกิด | ผู้สูงวัย | สุขภาพ | เทศกาล
//         แถว3: ครอบครัว | สัตว์เลี้ยง | กาแฟยามเช้า | วิวธรรมชาติ
//
// ───────────── การใช้งาน ─────────────
//   วางรูปไว้ที่ assets/richmenu/main.png และ assets/richmenu/categories.png
//   (หรือส่ง path เป็น argument: node scripts/line_richmenu.mjs <main> <categories>)
//   ตั้ง ENV: LINE_CHANNEL_ACCESS_TOKEN, (ออปชัน) APP_URL
//   แล้วรัน: node scripts/line_richmenu.mjs

import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const APP_URL = (process.env.APP_URL || 'https://leomcpemail-source.github.io/greeting/').replace(/\/+$/, '') + '/';
const MAIN_IMG = process.argv[2] || 'assets/richmenu/main.png';
const CATS_IMG = process.argv[3] || 'assets/richmenu/categories.png';

const ALIAS_MAIN = 'greeting-main';
const ALIAS_CATS = 'greeting-categories';
const W = 2500, H = 1686;

// หมวด (ลำดับตรงกับสเปกรูปด้านบน และ CATEGORIES ใน index.html)
const CATEGORIES = [
  { id: 'flowers',  label: 'ดอกไม้' },
  { id: 'dharma',   label: 'ธรรมะ' },
  { id: 'inspire',  label: 'กำลังใจ' },
  { id: 'miss',     label: 'คิดถึง' },
  { id: 'birthday', label: 'วันเกิด' },
  { id: 'elderly',  label: 'ผู้สูงวัย' },
  { id: 'health',   label: 'สุขภาพ' },
  { id: 'festival', label: 'เทศกาล' },
  { id: 'family',   label: 'ครอบครัว' },
  { id: 'pets',     label: 'สัตว์เลี้ยง' },
  { id: 'coffee',   label: 'กาแฟยามเช้า' },
  { id: 'nature',   label: 'วิวธรรมชาติ' },
];

// ── พิกัดช่องกด (ต้องตรงกับรูป) ──
const mainAreas = [
  { bounds: { x: 0,    y: 0, width: 1250, height: H }, action: { type: 'uri', uri: APP_URL } },
  { bounds: { x: 1250, y: 0, width: 1250, height: H }, action: { type: 'richmenuswitch', richMenuAliasId: ALIAS_CATS, data: 'to=categories' } },
];

function categoryAreas() {
  const BACK_H = 230, cols = 4, rows = 3;
  const colW = Math.floor(W / cols);          // 625
  const rowH = Math.floor((H - BACK_H) / rows); // 485
  const areas = [
    { bounds: { x: 0, y: 0, width: W, height: BACK_H }, action: { type: 'richmenuswitch', richMenuAliasId: ALIAS_MAIN, data: 'to=main' } },
  ];
  CATEGORIES.forEach((cat, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = col * colW, y = BACK_H + row * rowH;
    const width = col === cols - 1 ? W - x : colW;
    const height = row === rows - 1 ? H - y : rowH;
    areas.push({ bounds: { x, y, width, height }, action: { type: 'uri', uri: `${APP_URL}?cat=${cat.id}` } });
  });
  return areas;
}

// ── LINE Messaging API ──
const API = 'https://api.line.me';
const API_DATA = 'https://api-data.line.me';
const authH = () => ({ Authorization: `Bearer ${TOKEN}` });

async function lineJson(method, p, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...authH(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : {};
}

function imageContentType(file) {
  return /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
}

async function uploadImage(richMenuId, file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 1024 * 1024) throw new Error(`${file} ใหญ่เกิน 1MB (${(buf.length / 1024 / 1024).toFixed(2)}MB) — ย่อรูปก่อน`);
  const r = await fetch(`${API_DATA}/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...authH(), 'Content-Type': imageContentType(file) },
    body: buf,
  });
  if (!r.ok) throw new Error(`upload content → ${r.status} ${await r.text()}`);
}

async function cleanup() {
  // ลบ alias + rich menu เดิมทั้งหมด เพื่อเริ่มใหม่สะอาด ๆ (รันซ้ำได้)
  for (const a of [ALIAS_MAIN, ALIAS_CATS]) {
    await fetch(`${API}/v2/bot/richmenu/alias/${a}`, { method: 'DELETE', headers: authH() }).catch(() => {});
  }
  try {
    const list = await lineJson('GET', '/v2/bot/richmenu/list');
    for (const rm of list.richmenus || []) {
      await fetch(`${API}/v2/bot/richmenu/${rm.richMenuId}`, { method: 'DELETE', headers: authH() }).catch(() => {});
    }
  } catch { /* ignore */ }
}

async function createMenu(name, chatBarText, areas, file) {
  const { richMenuId } = await lineJson('POST', '/v2/bot/richmenu', {
    size: { width: W, height: H }, selected: true, name, chatBarText, areas,
  });
  await uploadImage(richMenuId, file);
  return richMenuId;
}

async function main() {
  if (!TOKEN) { console.error('ขาด ENV: LINE_CHANNEL_ACCESS_TOKEN'); process.exit(1); }
  for (const f of [MAIN_IMG, CATS_IMG]) {
    if (!fs.existsSync(f)) { console.error(`ไม่พบรูป: ${path.resolve(f)}\nเตรียมรูปตามสเปกในหัวไฟล์/LINE_SETUP.md ก่อนนะคะ`); process.exit(1); }
  }

  console.log('ลบเมนูเดิม…');
  await cleanup();

  console.log('สร้างเมนูหลัก (หน้าแรก | ตามหมวด)…');
  const idMain = await createMenu('greeting main', 'เมนู ☰', mainAreas, MAIN_IMG);
  console.log('สร้างเมนูหมวดหมู่ (12 หมวด)…');
  const idCats = await createMenu('greeting categories', 'เลือกหมวด ☰', categoryAreas(), CATS_IMG);

  console.log('ผูก alias + ตั้ง default…');
  await lineJson('POST', '/v2/bot/richmenu/alias', { richMenuAliasId: ALIAS_MAIN, richMenuId: idMain });
  await lineJson('POST', '/v2/bot/richmenu/alias', { richMenuAliasId: ALIAS_CATS, richMenuId: idCats });
  await lineJson('POST', `/v2/bot/user/all/richmenu/${idMain}`);

  console.log('\n✅ เสร็จ! เปิดแชต LINE OA จะเห็นเมนู "หน้าแรก / ตามหมวด" ด้านล่าง');
  console.log('   กด "ตามหมวด" → เห็น 12 หมวด → กดหมวดไหนก็เปิดเว็บแอพเข้าหมวดนั้น');
}

main().catch((e) => { console.error(e); process.exit(1); });
