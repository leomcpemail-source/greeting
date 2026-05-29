// scripts/generate.mjs
// รันโดย GitHub Actions ตอนดึก: gen รูปธีมตามวัน 30 รูป + กรองรูปแปลกด้วย vision + จัดการคลังคำอวยพร
// ใช้ fetch/fs ในตัวของ Node 20 ไม่ต้องลง dependency

import fs from 'node:fs';
import path from 'node:path';

// ---------- ตั้งค่า ----------
const TARGET = 30;          // จำนวนรูปที่ต้องการต่อวัน
const MAX_ATTEMPTS = 48;    // เพดานความพยายาม กันลูปไม่จบ
const IMG_SIZE = 800;       // ขนาดรูป (px)
const SLEEP_MS = 16000;     // เว้นห่างทุก request Pollinations (โควต้า ~1/15วิ ไม่ login)
const DAILY_BLESSINGS = 10; // คำอวยพรที่หยิบมาใช้ต่อวัน
const REUSE_AFTER_DAYS = 30;// คำอวยพรเว้นซ้ำกี่วัน
const VISION = true;        // เปิดการกรองรูปอัตโนมัติ

const OUT = path.resolve('output');
const IMG_DIR = path.join(OUT, 'img');

// ธีมประจำวัน (สีตามตำราไทย + ดอกไม้สำหรับ prompt)
const DAYS = [
  { th:'อาทิตย์',   en:'Sunday',    color:'#C0392B', c2:'#7d1f17', flower:'red roses and red hibiscus blossoms' },
  { th:'จันทร์',    en:'Monday',    color:'#E1A100', c2:'#8a5d00', flower:'yellow marigold and golden chrysanthemum' },
  { th:'อังคาร',    en:'Tuesday',   color:'#D6336C', c2:'#8a1d44', flower:'pink lotus and soft pink peony' },
  { th:'พุธ',       en:'Wednesday', color:'#1E9E55', c2:'#0f5e31', flower:'white jasmine on lush green foliage' },
  { th:'พฤหัสบดี',  en:'Thursday',  color:'#E8730C', c2:'#9c4a05', flower:'orange marigold garland' },
  { th:'ศุกร์',     en:'Friday',    color:'#1F73C4', c2:'#0f4677', flower:'blue morning glory and forget-me-nots' },
  { th:'เสาร์',     en:'Saturday',  color:'#7E3FAE', c2:'#4a2069', flower:'purple orchids and lavender' },
];
const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// เวลาไทย (UTC+7): job รันหลังเที่ยงคืน → ผลิตรูปของ "วันนี้" ที่เพิ่งขึ้นวันใหม่
function nowICT() { return new Date(Date.now() + 7 * 3600 * 1000); }

function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ---------- Pollinations: สร้างรูป ----------
async function genImage(prompt, seed) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
            + `?width=${IMG_SIZE}&height=${IMG_SIZE}&nologo=true&model=flux&seed=${seed}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'greeting-bot' } });
  if (!res.ok) throw new Error(`image http ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image')) throw new Error(`image bad content-type ${ct}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4000) throw new Error('image too small');
  return buf;
}

// ---------- Pollinations: ตรวจรูปด้วย vision ----------
async function checkImage(buf) {
  if (!VISION) return true;
  const b64 = buf.toString('base64');
  const body = {
    model: 'openai',
    max_tokens: 5,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text:
          'You are a strict QA checker for "good morning" greeting-card backgrounds. '
        + 'Reply with EXACTLY one word: OK or BAD. '
        + 'Reply BAD if the image has any readable text/letters/numbers/watermark, '
        + 'distorted or creepy human faces/hands, anything disturbing, or looks glitchy/low quality. '
        + 'Reply OK only if it is a clean, beautiful flower/nature background.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
      ]
    }]
  };
  try {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!res.ok) { console.log('  vision http', res.status, '→ ผ่านไปก่อน'); return true; }
    const data = await res.json();
    const ans = (data?.choices?.[0]?.message?.content || '').toUpperCase();
    return !ans.includes('BAD');
  } catch (e) {
    console.log('  vision error', e.message, '→ ผ่านไปก่อน');
    return true; // ถ้าตัวตรวจล่ม อย่าให้ทั้ง pipeline พัง
  }
}

// ---------- Pollinations: แต่งคำอวยพรใหม่ ----------
async function genBlessings(n) {
  const prompt =
    `แต่งคำอวยพรทักทายตอนเช้าภาษาไทย จำนวน ${n} ประโยค `
  + `แต่ละประโยคสั้น ไพเราะ เป็นมงคล ให้กำลังใจ ไม่ซ้ำกัน `
  + `ห้ามมีอิโมจิ ห้ามมีเลขลำดับ ห้ามมีคำว่า "สวัสดี" `
  + `ตอบกลับเป็น JSON array ของ string เท่านั้น เช่น ["...","..."]`;
  try {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model:'openai', messages:[{ role:'user', content: prompt }] })
    });
    const data = await res.json();
    let txt = data?.choices?.[0]?.message?.content || '';
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return arr.filter(x => typeof x === 'string' && x.trim().length > 4).map(x => x.trim());
  } catch (e) {
    console.log('genBlessings error', e.message);
    return [];
  }
}

// ---------- คลังคำอวยพร: หยิบไม่ซ้ำในรอบ 30 วัน ----------
async function pickBlessings(todayISO) {
  let pool = [];
  try { pool = JSON.parse(fs.readFileSync('prev/blessings.json','utf8')).pool || []; } catch {}
  const today = new Date(todayISO + 'T00:00:00Z').getTime();
  const eligible = () => pool.filter(b =>
    !b.lastUsed || (today - new Date(b.lastUsed + 'T00:00:00Z').getTime()) / 86400000 >= REUSE_AFTER_DAYS);

  // ถ้าคำที่ใช้ได้ไม่พอ → ให้ AI แต่งเพิ่มเข้า pool
  if (eligible().length < DAILY_BLESSINGS) {
    const need = (DAILY_BLESSINGS - eligible().length) + 8; // เผื่อไว้
    console.log(`คำอวยพรไม่พอ ขอ AI แต่งเพิ่ม ${need} คำ`);
    await sleep(SLEEP_MS);
    const fresh = await genBlessings(need);
    const existing = new Set(pool.map(b => b.text));
    for (const t of fresh) if (!existing.has(t)) { pool.push({ text:t, lastUsed:null }); existing.add(t); }
  }

  // สุ่มหยิบจากที่ใช้ได้
  const cand = eligible();
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [cand[i],cand[j]]=[cand[j],cand[i]]; }
  const chosen = cand.slice(0, DAILY_BLESSINGS);
  const chosenSet = new Set(chosen.map(b => b.text));
  for (const b of pool) if (chosenSet.has(b.text)) b.lastUsed = todayISO;

  fs.writeFileSync(path.join(OUT,'blessings.json'), JSON.stringify({ pool }, null, 2));
  return chosen.map(b => b.text);
}

// ---------- main ----------
async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const d = nowICT();
  const theme = DAYS[d.getUTCDay()];
  const todayISO = isoDate(d);
  const version = String(Date.now());
  const prompt =
    `${theme.flower}, soft golden morning sunlight, gentle dewdrops, dreamy blurred bokeh background, `
  + `serene auspicious mood, elegant, highly detailed, photographic, vertical composition, `
  + `no text, no letters, no numbers, no watermark, no people`;

  console.log(`=== วัน${theme.th} (${todayISO}) | เป้าหมาย ${TARGET} รูป ===`);

  const images = [];
  let attempt = 0;
  while (images.length < TARGET && attempt < MAX_ATTEMPTS) {
    attempt++;
    const seed = Math.floor(Math.random() * 1e9);
    try {
      console.log(`[${attempt}] gen seed=${seed} (ได้แล้ว ${images.length}/${TARGET})`);
      const buf = await genImage(prompt, seed);
      await sleep(SLEEP_MS);
      const ok = await checkImage(buf);
      await sleep(SLEEP_MS);
      if (!ok) { console.log('  ✗ vision: BAD ทิ้ง'); continue; }
      const idx = String(images.length).padStart(2,'0');
      fs.writeFileSync(path.join(IMG_DIR, `${idx}.jpg`), buf);
      images.push(`img/${idx}.jpg`);
      console.log('  ✓ เก็บเป็น', `${idx}.jpg`);
    } catch (e) {
      console.log('  ! error:', e.message, '→ รอแล้วลองใหม่');
      await sleep(SLEEP_MS);
    }
  }

  if (images.length === 0) throw new Error('gen ไม่ได้สักรูป — ยกเลิก');

  const blessings = await pickBlessings(todayISO);

  const manifest = {
    date: todayISO,
    dateThai: `วัน${theme.th} ที่ ${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()+543}`,
    dayTh: theme.th, dayEn: theme.en,
    color: theme.color, color2: theme.c2,
    count: images.length, images, blessings, version
  };
  fs.writeFileSync(path.join(OUT,'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`=== เสร็จ: ${images.length} รูป, ${blessings.length} คำอวยพร ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
