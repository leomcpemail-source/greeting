// scripts/generate.mjs
// รันโดย GitHub Actions ตอนดึก: gen รูปธีมตามวัน + กรองรูปแปลก + จัดการคลังคำอวยพร
// ใช้ fetch/fs ในตัวของ Node 20

import fs from 'node:fs';
import path from 'node:path';

// ---------- ตั้งค่า ----------
const TARGET = 100;             // จำนวนรูปที่ต้องการต่อวัน
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
  { th:'อาทิตย์',   en:'Sunday',    color:'#C0392B', c2:'#7d1f17', tone:'warm red',     flower:'red roses and red hibiscus blossoms' },
  { th:'จันทร์',    en:'Monday',    color:'#E1A100', c2:'#8a5d00', tone:'golden yellow', flower:'yellow marigold and golden chrysanthemum' },
  { th:'อังคาร',    en:'Tuesday',   color:'#D6336C', c2:'#8a1d44', tone:'soft pink',     flower:'pink lotus and soft pink peony' },
  { th:'พุธ',       en:'Wednesday', color:'#1E9E55', c2:'#0f5e31', tone:'fresh green',   flower:'white jasmine on lush green foliage' },
  { th:'พฤหัสบดี',  en:'Thursday',  color:'#E8730C', c2:'#9c4a05', tone:'warm orange',   flower:'orange marigold garland' },
  { th:'ศุกร์',     en:'Friday',    color:'#1F73C4', c2:'#0f4677', tone:'serene blue',   flower:'blue morning glory and forget-me-nots' },
  { th:'เสาร์',     en:'Saturday',  color:'#7E3FAE', c2:'#4a2069', tone:'royal purple',  flower:'purple orchids and lavender' },
];

// หัวข้อหลากหลาย — สุ่มต่อรูป (สไตล์ฝังในแต่ละหัวข้อ: ของจริง/3D/การ์ตูน)
const SUBJECTS = [
  // ดอกไม้ & ธรรมชาติ (ภาพถ่าย) — ใส่ซ้ำให้ออกบ่อย
  t => `a beautiful photographic arrangement of ${t.flower}, soft bokeh`,
  t => `a beautiful photographic arrangement of ${t.flower}, soft bokeh`,
  t => `a serene photographic sunrise over misty mountains`,
  t => `a cozy photographic cup of hot coffee by a sunny window`,
  t => `a peaceful photographic garden with dewy green leaves and morning mist`,
  t => `golden photographic rice fields glowing softly at dawn`,
  t => `a calm photographic lake reflecting the gentle morning sky`,
  // ผลไม้มงคล สีตามวัน
  t => `a beautiful arrangement of fresh auspicious fruits (oranges, pomegranate, pineapple, apples), glossy and vibrant, ${t.tone} tones, photographic`,
  // สัตว์/ลูกสัตว์น่ารัก (3D และ การ์ตูน)
  t => `an adorable cute baby animal in cheerful 3D Pixar render style, big sparkling eyes, chubby, wholesome, soft lighting`,
  t => `a charming cute cartoon animal character waving good morning, kawaii illustration, cheerful`,
  // เด็กน่ารัก (3D และ การ์ตูน) — wholesome
  t => `an adorable cheerful 3D Pixar style toddler smiling and waving hello, wholesome children's animation, fully clothed, bright and happy`,
  t => `a funny happy cartoon kid making a silly cheerful face, playful wholesome animated cartoon style, fully clothed`,
  // ตุ๊กตาน่ารัก
  t => `an adorable cute kawaii plush doll figurine, soft pastel colors, whimsical, soft studio lighting`,
];
const pickSubject = t => SUBJECTS[Math.floor(Math.random()*SUBJECTS.length)](t);
const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

// ===== เทศกาล =====
// theme เทศกาลจะ override สีประจำวัน: ใช้ color/c2/tone/headline/subjects(+blessings) ของเทศกาลแทน
// subjects เป็น string ตรงๆ (ไม่ใช่ฟังก์ชัน), blessings ใส่ก็ได้ (override คลังคำของวันนั้น)
const FX = {
  newyear: { color:'#C9A227', c2:'#7a5c12', tone:'festive gold and red', headline:'สวัสดีปีใหม่',
    subjects:['festive new year fireworks and golden confetti over a city skyline at night','golden champagne celebration with sparkles and ribbons','a glowing 2027 style golden new year bokeh celebration, no readable text'],
    blessings:['สวัสดีปีใหม่ ขอให้ปีนี้เป็นปีที่ดีที่สุด','ปีใหม่นี้ขอให้สุขภาพแข็งแรง ร่ำรวยเงินทอง','ขอให้สมหวังทุกสิ่งที่ตั้งใจในปีใหม่นี้'] },
  cny: { color:'#C8102E', c2:'#7a0a1c', tone:'lucky red and gold', headline:'สุขสันต์วันตรุษจีน',
    subjects:['Chinese New Year red lanterns and gold ingots, festive red and gold','a basket of lucky mandarin oranges with red and gold decoration','red Chinese lanterns glowing, plum blossoms, festive prosperity'],
    blessings:['ซินเจียยู่อี่ ซินนี้ฮวดไช้ สุขสันต์วันตรุษจีน','ขอให้ร่ำรวยเงินทอง ค้าขายรุ่งเรือง','โชคดีมีเฮง สุขภาพแข็งแรงตลอดปี'] },
  valentine: { color:'#E84A8A', c2:'#9c1f52', tone:'romantic pink and red', headline:'สุขสันต์วันวาเลนไทน์',
    subjects:['romantic red roses and soft pink hearts, valentine, dreamy bokeh','a bouquet of red roses with floating hearts, soft romantic light','pink and red hearts with rose petals, gentle romantic mood'],
    blessings:['สุขสันต์วันแห่งความรัก ขอให้มีแต่ความรักดีๆ','ขอให้คนรอบข้างรักและห่วงใยเสมอ','วันแห่งความรัก ขอให้หัวใจอบอุ่น'] },
  makha: { color:'#C79A3A', c2:'#6e5215', tone:'serene candlelight gold', headline:'วันมาฆบูชา',
    subjects:['lit candles and white lotus flowers, peaceful Buddhist holy day, serene golden glow, no buddha statue','glowing candles floating with lotus at dusk, tranquil temple atmosphere, no statue','soft candlelight and lotus, peaceful spiritual mood'],
    blessings:['วันมาฆบูชา ขอให้จิตใจสงบ พบแต่ความดีงาม','ทำความดี ละเว้นความชั่ว ทำจิตใจให้บริสุทธิ์','ขอบุญรักษา คุ้มครองให้แคล้วคลาดปลอดภัย'] },
  songkran: { color:'#19A7CE', c2:'#0c5d73', tone:'fresh aqua blue and white', headline:'สุขสันต์วันสงกรานต์',
    subjects:['Thai Songkran water festival, splashing clear water droplets, white jasmine garland, joyful, fresh aqua blue','white jasmine flowers and a silver bowl of water with petals, Thai new year, serene','cool splashing water and frangipani flowers, refreshing Songkran mood'],
    blessings:['สุขสันต์วันสงกรานต์ ขอให้ชุ่มฉ่ำใจตลอดปี','ปีใหม่ไทย ขอให้สุขภาพแข็งแรง คลายร้อนคลายทุกข์','ขอพรปีใหม่ไทย ให้โชคดีมีความสุข'] },
  visakha: { color:'#C79A3A', c2:'#6e5215', tone:'serene candlelight gold', headline:'วันวิสาขบูชา',
    subjects:['lit candles and white lotus, peaceful Buddhist holy day, golden serene glow, no buddha statue','glowing candles and lotus flowers at dusk, tranquil, no statue','soft candlelight, lotus pond, spiritual peaceful mood'],
    blessings:['วันวิสาขบูชา ขอให้จิตใจผ่องใส เปี่ยมด้วยเมตตา','ขอบุญกุศลคุ้มครองให้ร่มเย็นเป็นสุข','ทำดี คิดดี ชีวิตเป็นมงคล'] },
  asalha: { color:'#C79A3A', c2:'#6e5215', tone:'serene candlelight gold', headline:'วันอาสาฬหบูชา',
    subjects:['lit candles and white lotus, peaceful Buddhist holy day, golden serene glow, no buddha statue','glowing candles and lotus at dusk, tranquil temple light, no statue','soft candlelight and lotus flowers, spiritual calm'],
    blessings:['วันอาสาฬหบูชา ขอให้พบแต่สิ่งดีงาม','ขอธรรมะนำทางให้ชีวิตสงบสุข','ทำบุญวันพระใหญ่ ขอให้อิ่มบุญอิ่มใจ'] },
  mother: { color:'#2E78C7', c2:'#103f6e', tone:'soft sky blue and white', headline:'สุขสันต์วันแม่',
    subjects:['white jasmine flowers, mothers day, soft sky blue and white, elegant tender mood','a bouquet of white jasmine with soft blue ribbon, loving and gentle','white jasmine garland, warm tender mothers day atmosphere'],
    blessings:['สุขสันต์วันแม่ ขอให้แม่สุขภาพแข็งแรง','รักแม่ที่สุดในโลก ขอให้แม่มีความสุข','ขอให้ลูกได้ดูแลแม่ไปนานๆ'] },
  midautumn: { color:'#E0A21A', c2:'#8a5d00', tone:'warm golden moonlight', headline:'สุขสันต์วันไหว้พระจันทร์',
    subjects:['full bright moon over mooncakes and lanterns, mid autumn festival, warm golden glow','glowing paper lanterns and mooncakes under a full moon, festive warm mood','a big golden full moon with soft clouds and lanterns'],
    blessings:['สุขสันต์วันไหว้พระจันทร์ ขอให้ครอบครัวพร้อมหน้า','ขอให้ชีวิตกลมเกลียวเหมือนพระจันทร์เต็มดวง','โชคดีมีความสุข อิ่มเอมใจ'] },
  loykrathong: { color:'#E8A23A', c2:'#8a5210', tone:'warm candlelight gold on dark water', headline:'สุขสันต์วันลอยกระทง',
    subjects:['a beautiful krathong with lit candle and flowers floating on calm water at night, full moon, warm glow','many glowing krathong floating on a river under the full moon, festive serene night','a decorated banana-leaf krathong with candle and marigold on water, reflections'],
    blessings:['สุขสันต์วันลอยกระทง ขอให้ลอยทุกข์โศกไปกับสายน้ำ','ขอพรพระแม่คงคา ให้ชีวิตราบรื่น','คืนเพ็ญเดือนสิบสอง ขอให้สมหวังทุกประการ'] },
  father: { color:'#E1B100', c2:'#8a6a00', tone:'dignified golden yellow', headline:'สุขสันต์วันพ่อ',
    subjects:['yellow canna lily flowers, fathers day Thailand, golden yellow tones, dignified elegant','a bouquet of yellow flowers with warm golden light, respectful tender mood','golden yellow flowers, warm fathers day atmosphere'],
    blessings:['สุขสันต์วันพ่อ ขอให้พ่อสุขภาพแข็งแรง','รักพ่อมากที่สุด ขอให้พ่อมีความสุข','ขอให้ได้ดูแลพ่อไปนานแสนนาน'] },
  halloween: { color:'#E67324', c2:'#7a3a0c', tone:'playful orange and purple', headline:'สุขสันต์วันฮาโลวีน',
    subjects:['cute friendly smiling halloween pumpkins, playful not scary, orange and purple, cartoon','adorable cartoon halloween characters, cheerful pumpkins and candy, fun','cute kawaii halloween scene, friendly ghosts and pumpkins, playful'],
    blessings:['สุขสันต์วันฮาโลวีน วันนี้ขอให้สนุกๆ','Trick or Treat! ขอให้เจอแต่เรื่องน่ายินดี','วันปล่อยผี ขอให้สิ่งร้ายๆ ผ่านไป'] },
  christmas: { color:'#C1272D', c2:'#0f5132', tone:'festive red and green', headline:'สุขสันต์วันคริสต์มาส',
    subjects:['a cozy decorated Christmas tree with ornaments and warm lights, red and green, snowy','festive Christmas wreath and gifts, warm cozy glow, red and green','cute Christmas scene with snow, ornaments and soft lights'],
    blessings:['Merry Christmas ขอให้วันนี้อบอุ่นหัวใจ','สุขสันต์วันคริสต์มาส ขอให้สมปรารถนา','ขอให้ความสุขมาเยือนเหมือนของขวัญวันคริสต์มาส'] },
  childrens: { color:'#2EA0E0', c2:'#10567e', tone:'bright cheerful primary colors', headline:'สุขสันต์วันเด็ก',
    subjects:['cheerful cartoon children playing happily, bright colorful wholesome animation, fully clothed','cute 3D Pixar style kids laughing and waving, bright happy colors, wholesome','playful colorful balloons and cute cartoon kids, joyful childrens day'],
    blessings:['สุขสันต์วันเด็ก ขอให้เด็กๆ เติบโตอย่างมีความสุข','เด็กวันนี้ คือผู้ใหญ่ที่ดีในวันหน้า','ขอให้หนูๆ สดใส แข็งแรง เก่งกล้า'] },
};

// วันที่ตายตัวทุกปี (MM-DD)
const FX_FIXED = {
  '01-01': FX.newyear, '02-14': FX.valentine,
  '04-13': FX.songkran, '04-14': FX.songkran, '04-15': FX.songkran,
  '08-12': FX.mother, '10-31': FX.halloween, '12-05': FX.father, '12-25': FX.christmas,
};
// วันที่จันทรคติ/แปรผัน (YYYY-MM-DD) — อัปเดตรายปี (ชุดนี้ปี 2026/พ.ศ.2569)
const FX_DATED = {
  '2026-01-10': FX.childrens,   // วันเด็ก (เสาร์ที่ 2 ของ ม.ค.)
  '2026-02-17': FX.cny,         // ตรุษจีน
  '2026-03-03': FX.makha,       // มาฆบูชา
  '2026-05-31': FX.visakha,     // วิสาขบูชา
  '2026-07-29': FX.asalha,      // อาสาฬหบูชา
  '2026-09-25': FX.midautumn,   // ไหว้พระจันทร์
  '2026-11-25': FX.loykrathong, // ลอยกระทง
  // ปีถัดไปเติมที่นี่ เช่น '2027-02-06': FX.cny, ...
};
function getFestival(iso) {
  const mmdd = iso.slice(5);
  return FX_DATED[iso] || FX_FIXED[mmdd] || null;
}

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
          'Rate this "good morning" greeting-card image. Reply EXACTLY one word: OK or BAD. '
        + 'Cute cartoon/3D characters, animals, children, dolls, fruits, flowers, and nature are all OK. '
        + 'Reply BAD ONLY if it has LARGE prominent garbled text covering much of the image, '
        + 'a truly distorted/melted/creepy face, deformed extra limbs, or anything disturbing/gory. '
        + 'When unsure, reply OK.' },
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
  const dayTheme = DAYS[d.getUTCDay()];
  const todayISO = isoDate(d);
  const fest = getFestival(todayISO);          // null ถ้าไม่ใช่วันเทศกาล
  const theme = fest ? { ...dayTheme, ...fest } : dayTheme; // เทศกาล override สี/โทน
  const headline = fest ? fest.headline : `สวัสดีวัน${dayTheme.th}`;
  const version = String(Date.now());

  console.log(`=== ${headline} (${todayISO})${fest?' [เทศกาล]':''} | เป้าหมาย ${TARGET} รูป ===`);

  const images = [];
  let attempt = 0;
  while (images.length < TARGET && attempt < MAX_ATTEMPTS) {
    attempt++;
    const overBudget = (Date.now() - T0) > TIME_BUDGET_MS;
    const seed = Math.floor(Math.random() * 1e9);
    const subject = fest
      ? fest.subjects[Math.floor(Math.random()*fest.subjects.length)]
      : pickSubject(theme);
    const prompt =
      `${subject}, ${theme.tone} color palette, soft golden morning light, `
    + `dreamy, elegant, highly detailed, beautiful, `
    + `no text, no letters, no numbers, no watermark, no signature`;
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

  // คำอวยพร: วันเทศกาลใช้ชุดของเทศกาล, วันปกติหมุนจากคลัง
  const blessings = (fest && fest.blessings && fest.blessings.length)
    ? fest.blessings
    : await pickBlessings(todayISO);

  const manifest = {
    date: todayISO,
    dateThai: `วัน${dayTheme.th} ที่ ${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()+543}`,
    dayTh: dayTheme.th, dayEn: dayTheme.en,
    headline,
    isFestival: !!fest,
    festival: fest ? fest.headline : null,
    color: theme.color, color2: theme.c2,
    count: images.length, images, blessings, version
  };
  fs.writeFileSync(path.join(OUT,'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`=== เสร็จ: ${images.length} รูป, ${blessings.length} คำอวยพร${fest?' (เทศกาล: '+fest.headline+')':''} (ใช้เวลา ${Math.round((Date.now()-T0)/60000)} นาที) ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
