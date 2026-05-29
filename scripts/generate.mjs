// scripts/generate.mjs
// รันโดย GitHub Actions ตอนดึก: gen รูปธีมตามวัน + กรองรูปแปลก + จัดการคลังคำอวยพร
// ใช้ fetch/fs ในตัวของ Node 20

import fs from 'node:fs';
import path from 'node:path';

// ---------- ตั้งค่า ----------
const TARGET = 30;             // จำนวนรูปที่ต้องการต่อวัน
const MAX_ATTEMPTS = 60;       // เพดานความพยายาม
const IMG_SIZE = 800;
const MIN_GAP_MS = 15500;      // เว้นขั้นต่ำระหว่าง request Pollinations (โควต้า ~1/15วิ)
const DAILY_BLESSINGS = 10;
const REUSE_AFTER_DAYS = 30;
const VISION = true;           // กรองรูปอัตโนมัติ
const TIME_BUDGET_MS = 45 * 60 * 1000;  // เกินเท่านี้ → เลิกกรอง เติมให้ครบ
const IMG_TIMEOUT_MS = 120000; // timeout ต่อการ gen รูป
const TXT_TIMEOUT_MS = 45000;  // timeout ต่อ vision/text

const OUT = path.resolve('output');
const IMG_DIR = path.join(OUT, 'img');

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
const T0 = Date.now();

let lastReq = 0;
async function gate() {
  const wait = MIN_GAP_MS - (Date.now() - lastReq);
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
}

async function fetchT(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function nowICT() { return new Date(Date.now() + 7 * 3600 * 1000); }
function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function genImage(prompt, seed) {
  await gate();
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
            + `?width=${IMG_SIZE}&height=${IMG_SIZE}&nologo=true&model=flux&seed=${seed}`;
  const res = await fetchT(url, { headers: { 'User-Agent': 'greeting-bot' } }, IMG_TIMEOUT_MS);
  if (!res.ok) throw new Error(`image http ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image')) throw new Error(`bad content-type ${ct}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4000) throw new Error('image too small');
  return buf;
}

async function checkImage(buf) {
  if (!VISION) return true;
  const b64 = buf.toString('base64');
  const body = {
    model: 'openai', max_tokens: 5,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text:
          'Rate this "good morning" greeting-card background. Reply EXACTLY one word: OK or BAD. '
        + 'Reply BAD ONLY if it has LARGE prominent garbled text covering much of the image, '
        + 'a distorted/creepy human face or hand, or anything disturbing/gory. '
        + 'Small faint text, logos, or pure flowers/nature = OK. When unsure, reply OK.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
      ]
    }]
  };
  try {
    await gate();
    const res = await fetchT('https://text.pollinations.ai/openai',
      { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }, TXT_TIMEOUT_MS);
    if (!res.ok) return true;
    const data = await res.json();
    const ans = (data?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    return !ans.startsWith('BAD');
  } catch { return true; }
}

async function genBlessings(n) {
  const prompt =
    `แต่งคำอวยพรทักทายตอนเช้าภาษาไทย จำนวน ${n} ประโยค `
  + `แต่ละประโยคสั้น ไพเราะ เป็นมงคล ให้กำลังใจ ไม่ซ้ำกัน `
  + `ห้ามมีอิโมจิ ห้ามมีเลขลำดับ ห้ามมีคำว่า "สวัสดี" `
  + `ตอบกลับเป็น JSON array ของ string เท่านั้น เช่น ["...","..."]`;
  try {
    await gate();
    const res = await fetchT('https://text.pollinations.ai/openai',
      { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'openai', messages:[{ role:'user', content: prompt }] }) }, TXT_TIMEOUT_MS);
    const data = await res.json();
    const m = (data?.choices?.[0]?.message?.content || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    return JSON.parse(m[0]).filter(x => typeof x === 'string' && x.trim().length > 4).map(x => x.trim());
  } catch (e) { console.log('genBlessings error', e.message); return []; }
}

async function pickBlessings(todayISO) {
  let pool = [];
  try { pool = JSON.parse(fs.readFileSync('prev/blessings.json','utf8')).pool || []; } catch {}
  const today = new Date(todayISO + 'T00:00:00Z').getTime();
  const eligible = () => pool.filter(b =>
    !b.lastUsed || (today - new Date(b.lastUsed + 'T00:00:00Z').getTime()) / 86400000 >= REUSE_AFTER_DAYS);

  if (eligible().length < DAILY_BLESSINGS) {
    const need = (DAILY_BLESSINGS - eligible().length) + 8;
    console.log(`คำอวยพรไม่พอ ขอ AI แต่งเพิ่ม ${need} คำ`);
    const fresh = await genBlessings(need);
    const existing = new Set(pool.map(b => b.text));
    for (const t of fresh) if (!existing.has(t)) { pool.push({ text:t, lastUsed:null }); existing.add(t); }
  }

  const cand = eligible();
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [cand[i],cand[j]]=[cand[j],cand[i]]; }
  const chosen = cand.slice(0, DAILY_BLESSINGS);
  const set = new Set(chosen.map(b => b.text));
  for (const b of pool) if (set.has(b.text)) b.lastUsed = todayISO;

  fs.writeFileSync(path.join(OUT,'blessings.json'), JSON.stringify({ pool }, null, 2));
  return chosen.map(b => b.text);
}

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
    const overBudget = (Date.now() - T0) > TIME_BUDGET_MS;
    const seed = Math.floor(Math.random() * 1e9);
    try {
      console.log(`[${attempt}] gen seed=${seed} (ได้แล้ว ${images.length}/${TARGET})${overBudget?' [เกินงบ-ไม่กรอง]':''}`);
      const buf = await genImage(prompt, seed);
      if (!overBudget && !(await checkImage(buf))) { console.log('  ✗ vision: BAD ทิ้ง'); continue; }
      const idx = String(images.length).padStart(2,'0');
      fs.writeFileSync(path.join(IMG_DIR, `${idx}.jpg`), buf);
      images.push(`img/${idx}.jpg`);
      console.log('  ✓ เก็บเป็น', `${idx}.jpg`);
    } catch (e) {
      console.log('  ! error:', e.message);
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
  console.log(`=== เสร็จ: ${images.length} รูป, ${blessings.length} คำอวยพร (ใช้เวลา ${Math.round((Date.now()-T0)/60000)} นาที) ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
