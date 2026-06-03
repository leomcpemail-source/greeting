// scripts/generate.mjs
// รันโดย GitHub Actions ตอนดึก: gen รูปธีมตามวัน + กรองรูปแปลก + จัดการคลังคำอวยพร
// ใช้ fetch/fs ในตัวของ Node 20

import fs from 'node:fs';
import path from 'node:path';
import { dhash, isDuplicate, hashToStr } from './lib/phash.mjs';
import { scorePanel } from './lib/rubric.mjs';
import { photosEnabled, fetchStockPhoto } from './lib/photos.mjs';

// ---------- ตั้งค่า ----------
// GitHub Actions free tier: job timeout สูงสุด 1h30m (5400วิ)
// ประมาณการ: ~90วิ/รูป (จาก log จริง) × 40 รูป = 60 นาที + buffer 30 นาที = 90 นาที ✓
const TARGET = 30;               // ลด 40 → 30 ให้ "ทุกรูป" ผ่าน vision ได้ภายในงบเวลา (carousel สุ่ม combo ได้ไม่จำกัดอยู่แล้ว 30 รูปพอ)
const MAX_ATTEMPTS = 60;         // TARGET * 2 (เผื่อ reject ~50%)
const IMG_SIZE = 800;
const MIN_GAP_MS = 15500;       // เว้นขั้นต่ำระหว่าง request Pollinations (โควต้า ~1/15วิ)
const VISION = true;            // กรองรูปอัตโนมัติ
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY    || '';
// Pollinations ย้ายมา gen.pollinations.ai แล้ว — เรียกฝั่ง server ต้องมี secret key (sk_) จาก enter.pollinations.ai
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || '';
const POLLINATIONS_MODEL   = process.env.POLLINATIONS_MODEL   || 'flux';
// vetting: ผ่านเมื่อมี AI ตอบ >= ค่านี้ (1 = ให้ AI ตัวเดียวตัดสินได้ถ้าอีกตัวล่ม กันรูปกอง pending)
const MIN_VOTERS = Number(process.env.MIN_VOTERS || 1);
const PHOTO_SHARE = Number(process.env.PHOTO_SHARE || 0.92);          // สัดส่วนใช้รูปถ่าย Pexels (Pollen หมด -> พึ่ง Pexels เป็นหลัก)
const PHOTO_TRUST_NOVOTE = (process.env.PHOTO_TRUST_NOVOTE || '1') !== '0'; // รูปถ่าย curated: ถ้า AI ล่มหมด (0 โหวต) ให้ผ่านได้ (กันหน้าว่าง)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GROQ_API_KEY       = process.env.GROQ_API_KEY       || '';
// หยุด gen รูปเมื่อเหลือเวลาน้อยกว่า STOP_BEFORE_END_MS — เพื่อให้มีเวลา gen คำ + push
const TIME_BUDGET_MS = 55 * 60 * 1000;  // 55 นาที
const STOP_BEFORE_END_MS = 75 * 60 * 1000; // หยุดถ้าผ่านไป 75 นาที (เหลือ 15 นาที buffer)
const IMG_TIMEOUT_MS = 120000;  // timeout ต่อการ gen รูป
const TXT_TIMEOUT_MS = 45000;   // timeout ต่อ vision/text
// สัดส่วน subjects เทศกาล vs ทั่วไป (วันปกติ = 100% ทั่วไป)
const FEST_SUBJECT_RATIO = 0.4; // 40% เทศกาล, 60% ทั่วไป

// ── ระบบให้คะแนนความสวย (AI ตรวจตอนดึก) ───────────────────────────────
// vision จะให้คะแนน 1-10 ในการเรียกเดียวกับการเช็ค OK/BAD (ไม่เพิ่มจำนวน request)
// รูปที่คะแนนต่ำกว่า MIN_SCORE จะถูกทิ้งแล้ว gen ใหม่ (เหมือน BAD) → คลังเหลือแต่รูปสวย
const MIN_SCORE = 4;              // คะแนนความสวยขั้นต่ำ (1-10) ต่ำกว่านี้ทิ้ง regen (ลด 5→4 ให้ได้รูปมากขึ้น)
const MIN_KEEP = 30;              // ตั้งใจให้ได้อย่างน้อยกี่รูป — ถ้าตามไม่ทันจะผ่อนเกณฑ์เร็วขึ้น
const SCORE_RELAX_AT = 0.6;       // ถ้าใช้ attempts เกิน 60% แล้ว → ผ่อนเกณฑ์คะแนนลง (กันรูปไม่ครบ)
const SCORE_RELAX_BY = 2;         // ผ่อนคะแนนขั้นต่ำลงกี่แต้มเมื่อ relax
const TIME_RELAX_MS = 50 * 60 * 1000; // ผ่านไป 50 นาทียังไม่ครบ MIN_KEEP → ผ่อนเกณฑ์ (เลื่อนจาก 45→50; รอบ TARGET=30 ปกติเสร็จ ~25-30 นาที ไม่ถึงจุดนี้)
const REQUIRE_TEXT_SAFE = true;   // ทิ้งรูปที่ตรงกลางรกเกินไป (ข้อความจะบังจุดสำคัญ) — เปิดเป็นด่านกันข้อความบังรูป

// ── Cascade: Pollinations กรองหยาบก่อน → คะแนนก้ำกึ่งค่อยส่ง Gemini ชี้ขาด ──
// ฟรี/เร็วด้วย Pollinations เป็นด่านแรก, ใช้ Gemini (แม่นกว่า) เฉพาะรูปที่ตัดสินยาก
// → ประหยัดโควตา Gemini และมี fallback กลับ Pollinations ถ้า Gemini ล่ม/เต็มโควตา
const GEMINI_VISION = true;       // false = ใช้ Pollinations ล้วน (ปิด Gemini)
const BORDER_LO = 5;              // โซนก้ำกึ่ง: คะแนน Pollinations ในช่วง BORDER_LO..BORDER_HI
const BORDER_HI = 6;              //   เท่านั้นที่ส่งต่อให้ Gemini ตัดสินชี้ขาด
const GEMINI_VISION_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash']; // เร็ว+เสถียรก่อน แล้ว fallback
const GEM_TIMEOUT_MS = Number(process.env.GEM_TIMEOUT_MS || 60000); // Gemini ให้เวลามากกว่า vision Pollinations

// ── ตรวจ "ภาพประกอบจริง" (รูป+กรอบ+ข้อความ) แทนรูปดิบ ──────────────────────
// เปิดสวิตช์นี้ → ใช้ headless browser (Puppeteer) ประกอบการ์ดเหมือนที่เว็บแสดง
// แล้วให้ AI ตรวจสิ่งที่ user เห็นจริง พร้อม "ตรึง" กรอบ/เลย์เอาต์/คำ ลง manifest.cards[]
// ดีฟอลต์ = false (ปลอดภัย, พฤติกรรมเดิม) ; ถ้า Puppeteer ล่ม จะ fallback ตรวจรูปดิบอัตโนมัติ
// ต้องมี: `npm i puppeteer` + ติดตั้ง Chromium (ดู workflow) ก่อนเปิด
const COMPOSITE_SCORING = process.env.COMPOSITE_SCORING === '1';  // เปิดด้วย env COMPOSITE_SCORING=1
const INDEX_HTML_PATH = path.resolve('index.html');

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
// ยิ่งมีมาก ยิ่งลดซ้ำใน 100 รูป/วัน
const SUBJECTS = [
  // ── ดอกไม้ตามวัน (ออกบ่อยสุด ใส่ 3 variant) ──────────────────────────
  t => `a beautiful photographic arrangement of ${t.flower}, soft bokeh, macro`,
  t => `close-up photographic ${t.flower} with morning dew drops, shallow depth of field`,
  t => `elegant flat lay of ${t.flower} on white marble, overhead, soft natural light`,
  // ── ธรรมชาติ & ภูมิทัศน์ ─────────────────────────────────────────────
  t => `a serene photographic sunrise over misty mountains, golden hour`,
  t => `misty forest with golden sunlight streaming through trees, morning atmosphere`,
  t => `peaceful waterfall in lush tropical forest, soft light, long exposure`,
  t => `a calm photographic lake reflecting the gentle morning sky and clouds`,
  t => `golden photographic rice fields glowing softly at dawn, rural Thailand`,
  t => `aerial view of green tea terraces at sunrise, mist in valleys, serene`,
  t => `a peaceful photographic garden with dewy green leaves and morning mist`,
  t => `sakura cherry blossom tree in full bloom, soft pink petals, morning light`,
  t => `rolling green hills with wildflowers, blue sky, fresh morning light`,
  t => `sunrise over calm ocean with soft pastel sky, peaceful horizon`,
  t => `wooden bridge over a lotus pond at sunrise, tranquil Thai countryside`,
  // ── กาแฟ & ของกินน่ารัก ──────────────────────────────────────────────
  t => `a cozy photographic cup of hot coffee by a sunny window, steam rising`,
  t => `latte art in a ceramic cup, morning light, warm cozy atmosphere`,
  t => `a pretty breakfast spread with fruits and flowers, top-down photographic`,
  t => `matcha tea in a beautiful bowl with cherry blossoms, serene Japanese style`,
  // ── ผลไม้มงคล ─────────────────────────────────────────────────────────
  t => `a beautiful arrangement of fresh auspicious fruits (oranges, pomegranate, pineapple, apples), glossy and vibrant, ${t.tone} tones, photographic`,
  t => `golden ripe mangoes and tropical fruits on a leaf-lined wooden tray, warm light`,
  t => `glistening fresh strawberries and blueberries with flowers, bright cheerful`,
  // ── สัตว์น่ารัก 3D / การ์ตูน ─────────────────────────────────────────
  t => `an adorable cute baby animal in cheerful 3D Pixar render style, big sparkling eyes, chubby, wholesome, soft lighting`,
  t => `a charming cute cartoon animal character waving good morning, kawaii illustration, cheerful`,
  t => `a fluffy baby rabbit in a flower meadow, 3D Pixar style, soft morning light`,
  t => `a tiny cute baby panda eating bamboo, 3D cartoon style, cheerful, wholesome`,
  t => `adorable baby elephant with big ears, kawaii 3D style, happy, morning light`,
  t => `a cute cartoon cat with big eyes sitting in a sunny window, soft illustration`,
  t => `baby chicks hatching from colorful eggs, 3D kawaii style, cheerful spring`,
  t => `a plump cartoon corgi puppy with a flower crown, kawaii illustration, pastel`,
  // ── ตุ๊กตา & ของสะสม ──────────────────────────────────────────────────
  t => `an adorable cute kawaii plush doll figurine, soft pastel colors, whimsical, soft studio lighting`,
  t => `a cute Molang-style bunny plush doll in a flower garden, soft pastel, kawaii`,
  t => `tiny ceramic animal figurines in a miniature garden scene, macro, charming`,
  // ── ฉาก & บรรยากาศ ────────────────────────────────────────────────────
  t => `a cozy reading nook by a window with morning sun, potted plants, warm atmosphere`,
  t => `a dreamy hot air balloon over misty mountains at sunrise, pastel sky`,
  t => `paper origami cranes in soft pastel colors on white background, artistic`,
  t => `a magical fairy-tale forest with glowing fireflies at dawn, enchanting`,
  t => `colorful paper lanterns hanging over a quiet garden path, festive warm glow`,
  t => `a beautiful mandala of flower petals on water surface, overhead, vibrant`,
  // ── ศาสนาพุทธ ──────────────────────────────────────────────────────────
  t => `serene golden Buddha statue glowing softly, surrounded by lotus flowers, peaceful temple garden, morning mist, respectful, no text`,
  t => `ancient Thai Buddhist temple with golden pagoda at sunrise, reflection in still water, lush greenery, no people`,
  t => `tall white stupa pagoda surrounded by tropical trees, golden spire glowing at dawn, peaceful, no people`,
  t => `ornate Thai temple roof with gilded chedi spires against blue sky, traditional architecture, no people, no text`,
  t => `a lotus pond in front of a golden Thai temple at sunrise, reflections, peaceful, no people`,
  t => `row of golden Buddha statues in a temple corridor, soft morning light, reverent atmosphere, no text`,
  t => `Thai temple bell tower surrounded by tropical trees, warm golden light, serene, no people`,
  // ── เทพจีน ────────────────────────────────────────────────────────────
  t => `serene smiling Guanyin Bodhisattva statue in garden, surrounded by white lotuses, soft golden light, peaceful, respectful, no text`,
  t => `ornate Chinese temple with red lanterns glowing at dawn, dragon roof detail, koi pond reflection, no people`,
  t => `dignified Guan Yu statue with red robe on temple altar, incense and offerings, warm light, respectful, no text`,
  t => `Chinese temple courtyard with ancient bell, red pillars, koi pond, golden morning light, tranquil, no people, no text`,
  t => `golden Maitreya laughing Buddha statue with lotus base, surrounded by flowers, peaceful garden, no text`,
  // ── สไตล์ตามภาพตัวอย่าง user: มินิมอล + ประธานกึ่งกลาง พื้นหลังสีเรียบตามสีวัน เว้นที่ว่างใส่ข้อความ ──
  // (พื้นหลังโล่ง = ตัวอักษรอ่านง่ายตอนประกอบการ์ด → คะแนน composite ดีขึ้น)
  t => `a serene minimalist Buddha bust portrait with calm downcast eyes and golden robe, centered on a clean solid ${t.tone} background, lots of empty negative space, soft even studio lighting, devotional, respectful, no text`,
  t => `a golden Buddha statue seated on a lotus with an intricate ornate golden aura halo behind, white lotus flowers beside, on a rich solid ${t.tone} background, symmetrical, devotional, soft divine glow, respectful, no text`,
  t => `a serene smiling Guanyin Bodhisattva statue centered on a clean solid ${t.tone} background, soft golden glow, a few white lotus flowers, minimalist devotional, generous empty space, respectful, no text`,
  t => `a single elegant ${t.flower} stem on a clean solid pastel ${t.tone} background, minimalist, large empty negative space, soft studio light, calm, no text`,
  t => `two adorable round chubby smiling 3D characters together with a cozy coffee cup and daisies, on a clean warm ${t.tone} background, kawaii minimalist, lots of empty space, cheerful, soft lighting, no text`,
  t => `one adorable baby animal in cute 3D Pixar style, centered on a clean solid pastel ${t.tone} background, big sparkling eyes, chubby wholesome, lots of empty space, soft lighting, no text`,
  t => `a minimalist cozy coffee cup with a single small flower, on a clean solid ${t.tone} background, lots of empty space above, gentle top-down view, soft morning light, no text`,
  t => `a single lotus flower floating on calm still water, minimalist clean ${t.tone} tones, lots of negative space, serene zen mood, soft light, no text`,
  t => `a small golden Buddha amulet and a white lotus on a clean solid ${t.tone} surface, minimalist flat lay, generous empty space, soft warm light, respectful, no text`,
  // ── ครอบครัวอบอุ่น แนวภาพถ่ายจริง (เลี่ยงโคลสอัพใบหน้า ลดปัญหาหน้าเพี้ยน) ──
  t => `a warm candid photograph of a happy family enjoying a cozy morning together at home, soft natural window light, gentle bokeh, heartwarming, lifestyle photography`,
  t => `a photographic silhouette of a loving family walking together at sunrise, warm golden backlight, peaceful tender mood, real photo`,
  t => `a warm photographic moment of grandparents and grandchild smiling together in a sunlit garden, soft focus, candid family photography, natural light`,
  t => `a cozy real photograph of a family having breakfast at a sunny table with flowers, warm morning light, candid lifestyle, heartwarming`,
  // ── เน้นดอกไม้ & ต้นไม้ มากขึ้น (แนวภาพถ่ายจริง) ──
  t => `a lush photographic field of blooming ${t.flower} stretching to the horizon at golden hour, soft dreamy focus`,
  t => `a beautiful blooming flower tree in full bloom in a sunlit park, petals drifting, soft morning light, photographic`,
  t => `a macro photograph of colorful blooming flowers with soft bokeh garden background, vibrant, fresh morning dew`,
  t => `a vibrant photographic bouquet of mixed garden flowers in a rustic vase by a window, warm natural morning light`,
  t => `a peaceful photographic garden path lined with blooming flowers and lush green trees, gentle morning sun rays`,
  t => `a single majestic old tree on a green hill at sunrise, soft mist, serene photographic landscape`,
  t => `cherry blossom branches full of pink flowers against a soft blue sky, photographic, gentle light`,
  t => `a tranquil photographic pond surrounded by blooming lotus and water lilies, lush greenery, morning calm`,
  // ── การ์ตูนน่ารัก (ในขอบเขต: สัตว์/ครอบครัว/วัด — เลี่ยงการ์ตูนสิ่งศักดิ์สิทธิ์เพื่อความเคารพ) ──
  t => `a heartwarming cute cartoon family of animals having breakfast together in a cozy home, kawaii 3D Pixar style, warm and wholesome`,
  t => `an adorable kawaii illustration of a little Thai temple among trees with a cute cat resting nearby, warm pastel, gentle, respectful`,
  t => `a wholesome 3D cartoon scene of a cozy family garden full of flowers with a happy little pet, Pixar style, warm morning light`,
  t => `a cute cartoon mother and baby animal cuddling in a flower meadow, kawaii 3D style, tender wholesome, soft morning light`,
];

// สุ่มแบบไม่ซ้ำ subject ใน session เดียวกัน (วนซ้ำได้เมื่อหมด pool)
let _subjectQueue = [];
function pickSubject(t) {
  if (_subjectQueue.length === 0) {
    // shuffle SUBJECTS ใหม่ทุกรอบ
    _subjectQueue = [...Array(SUBJECTS.length).keys()];
    for (let i = _subjectQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [_subjectQueue[i], _subjectQueue[j]] = [_subjectQueue[j], _subjectQueue[i]];
    }
  }
  return SUBJECTS[_subjectQueue.pop()](t);
}

// seed ไม่ซ้ำกันในวันเดียว
const _usedSeeds = new Set();
function uniqueSeed() {
  let s;
  do { s = Math.floor(Math.random() * 1e9); } while (_usedSeeds.has(s));
  _usedSeeds.add(s);
  return s;
}
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
    subjects:['lit candles and white lotus flowers, peaceful Buddhist holy day, serene golden glow','glowing candles floating with lotus at dusk, tranquil Thai temple atmosphere, golden spire in background','serene golden Buddha statue surrounded by candles and lotus flowers, makha bucha, respectful, no text','Thai Buddhist monks in saffron robes walking around white stupa at night carrying candles, bokeh lights, peaceful'],
    blessings:['วันมาฆบูชา ขอให้จิตใจสงบ พบแต่ความดีงาม','ทำความดี ละเว้นความชั่ว ทำจิตใจให้บริสุทธิ์','ขอบุญรักษา คุ้มครองให้แคล้วคลาดปลอดภัย'] },
  songkran: { color:'#19A7CE', c2:'#0c5d73', tone:'fresh aqua blue and white', headline:'สุขสันต์วันสงกรานต์',
    subjects:['Thai Songkran water festival, splashing clear water droplets, white jasmine garland, joyful, fresh aqua blue','white jasmine flowers and a silver bowl of water with petals, Thai new year, serene','cool splashing water and frangipani flowers, refreshing Songkran mood'],
    blessings:['สุขสันต์วันสงกรานต์ ขอให้ชุ่มฉ่ำใจตลอดปี','ปีใหม่ไทย ขอให้สุขภาพแข็งแรง คลายร้อนคลายทุกข์','ขอพรปีใหม่ไทย ให้โชคดีมีความสุข'] },
  visakha: { color:'#C79A3A', c2:'#6e5215', tone:'serene candlelight gold', headline:'วันวิสาขบูชา',
    subjects:['lit candles and white lotus, peaceful Buddhist holy day, golden serene glow','serene golden Buddha statue surrounded by thousands of candles and lotus flowers, visakha puja, night ceremony, respectful, no text','Thai Buddhist monks walking with candles around white stupa at night, bokeh lights, sacred ceremony','lotus flowers floating on candlelit water, temple golden spire reflection, peaceful night'],
    blessings:['วันวิสาขบูชา ขอให้จิตใจผ่องใส เปี่ยมด้วยเมตตา','ขอบุญกุศลคุ้มครองให้ร่มเย็นเป็นสุข','ทำดี คิดดี ชีวิตเป็นมงคล'] },
  asalha: { color:'#C79A3A', c2:'#6e5215', tone:'serene candlelight gold', headline:'วันอาสาฬหบูชา',
    subjects:['lit candles and white lotus, peaceful Buddhist holy day, golden serene glow','serene golden Buddha statue with Dhamma wheel, asalha puja, soft temple light, respectful, no text','Thai temple golden pagoda at sunrise with lotus pond, peaceful no people','Buddhist monk receiving alms at sunrise, golden light, misty temple garden, reverent atmosphere'],
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
  // ── วันสำคัญ/วันหยุดราชการเพิ่มเติม พ.ศ.2569 (ที่มา: kapook) ──
  // royal: ใช้ภาพเชิงสัญลักษณ์ (ดอกไม้/สถาปัตยกรรม/แสงเทียน) — ไม่สร้างภาพบุคคลในราชวงศ์
  // solemn:true = วันรำลึก ใช้คำสุภาพ ไม่ใช้โทนรื่นเริง ; ownBlessings:true = ใช้คำของวันนั้นโดยตรง (ไม่ gen)
  chakri: { color:'#B38A2D', c2:'#6e5215', tone:'dignified gold and Thai royal', headline:'วันจักรี', ownBlessings:true,
    subjects:['majestic Thai royal architecture, golden Grand Palace spires at sunrise, dignified, respectful, no people, no text','golden Thai royal pavilion with lotus pond at dawn, serene patriotic mood, no text','elegant Thai gold and crimson ornamental pattern with soft morning light'],
    blessings:['๖ เมษายน วันจักรี น้อมรำลึกพระมหากรุณาธิคุณแห่งราชวงศ์จักรี','วันจักรี ขอน้อมสำนึกในพระมหากรุณาธิคุณ','รำลึกถึงบูรพมหากษัตริย์แห่งราชวงศ์จักรี'] },
  labour: { color:'#1F73C4', c2:'#0f4677', tone:'fresh hopeful blue and sunrise', headline:'วันแรงงานแห่งชาติ', ownBlessings:true,
    subjects:['bright hopeful sunrise over green fields, fresh new day, uplifting, no text','sunflowers turning to the morning sun, hopeful bright mood','soft warm morning light over a calm landscape, fresh and encouraging'],
    blessings:['สุขสันต์วันแรงงาน ขอบคุณทุกแรงกายที่ร่วมสร้างสังคม','วันแรงงานแห่งชาติ ขอให้ทุกท่านสุขภาพแข็งแรง มีกำลังใจ','ขอให้ผลของความเพียร นำพาความสุขความเจริญ'] },
  coronation: { color:'#D4AF37', c2:'#8a6a00', tone:'regal gold', headline:'วันฉัตรมงคล', ownBlessings:true,
    subjects:['regal golden marigold (ดาวเรือง) garland with soft royal light, elegant respectful, no people, no text','golden Thai temple spire glowing at dawn, serene majestic','golden Thai ornamental pattern with warm light, dignified'],
    blessings:['วันฉัตรมงคล ขอน้อมสำนึกในพระมหากรุณาธิคุณ','ทรงพระเจริญ','๔ พฤษภาคม วันฉัตรมงคล ขอพระองค์ทรงพระเจริญยิ่งยืนนาน'] },
  plant: { color:'#1E9E55', c2:'#0f5e31', tone:'lush auspicious green and gold rice', headline:'วันพืชมงคล', ownBlessings:true,
    subjects:['golden ripe rice fields at sunrise, abundant harvest, lush green and gold, no text','green rice paddy with morning mist and golden light, fertile auspicious','heavy golden rice grains close up, prosperity and abundance'],
    blessings:['วันพืชมงคล ขอให้พืชผลอุดมสมบูรณ์ ชีวิตมั่งคั่ง','ขอให้ปีนี้ทำมาค้าขึ้น ผลผลิตงอกงาม','วันมงคลของเกษตรกรไทย ขอให้ฟ้าฝนเป็นใจ'] },
  khaopansa: { color:'#C79A3A', c2:'#6e5215', tone:'serene candlelight gold', headline:'วันเข้าพรรษา', ownBlessings:true,
    subjects:['lit candles and white lotus in a peaceful temple, golden serene glow, no text','rows of glowing yellow candle offerings, Buddhist lent, tranquil','golden temple hall with soft candlelight and lotus, sacred peaceful'],
    blessings:['วันเข้าพรรษา ขอให้จิตใจสงบ ตั้งมั่นในความดี','ช่วงเข้าพรรษา ลด ละ เลิก สิ่งไม่ดี เพื่อใจที่ผ่องใส','ขอบุญรักษา ให้ชีวิตร่มเย็นเป็นสุข'] },
  queen: { color:'#5B3FA0', c2:'#33215e', tone:'elegant royal purple', headline:'วันเฉลิมพระชนมพรรษา สมเด็จพระนางเจ้าฯ พระบรมราชินี', ownBlessings:true,
    subjects:['elegant purple orchids and royal violet flowers with soft golden light, graceful, respectful, no people, no text','graceful purple iris and lavender bouquet, regal gentle mood','soft royal purple flowers with gold accents, refined elegant'],
    blessings:['ทรงพระเจริญ','๓ มิถุนายน ขอพระองค์ทรงพระเจริญยิ่งยืนนาน','ด้วยเกล้าด้วยกระหม่อม ขอเดชะ'] },
  king10: { color:'#E1B100', c2:'#8a6a00', tone:'regal golden yellow', headline:'วันเฉลิมพระชนมพรรษา พระบาทสมเด็จพระเจ้าอยู่หัว', ownBlessings:true,
    subjects:['regal golden yellow flowers and marigold with soft light, dignified, respectful, no people, no text','golden Thai ornamental pattern with yellow blossoms, elegant majestic','bright golden yellow chrysanthemum bouquet, warm respectful royal mood'],
    blessings:['ทรงพระเจริญ','๒๘ กรกฎาคม ขอพระองค์ทรงพระเจริญยิ่งยืนนาน','ด้วยเกล้าด้วยกระหม่อม ขอเดชะ'] },
  memorial9: { color:'#9b8b66', c2:'#4a4231', tone:'solemn muted gold, respectful, calm dark', headline:'น้อมรำลึกในพระมหากรุณาธิคุณ', solemn:true, ownBlessings:true,
    subjects:['a single elegant yellow marigold on calm dark background, solemn respectful tribute, soft dim light, no people, no text','gentle yellow marigold with quiet candlelight, dignified tribute, dark serene, no text','soft muted golden light over still water at dusk, calm reverent solemn mood'],
    blessings:['๑๓ ตุลาคม น้อมรำลึกในพระมหากรุณาธิคุณอันหาที่สุดมิได้','สถิตอยู่ในใจตราบนิรันดร์','ด้วยสำนึกในพระมหากรุณาธิคุณเป็นล้นพ้นอันหาที่สุดมิได้'] },
  chulalongkorn: { color:'#9C2E5A', c2:'#5e1c37', tone:'dignified respectful rose', headline:'วันปิยมหาราช', solemn:true, ownBlessings:true,
    subjects:['elegant pink and red roses laid as a respectful tribute, dignified memorial, soft light, no people, no text','graceful rose arrangement with calm reverent mood, respectful tribute, no text','soft roses with gentle morning light, dignified memorial atmosphere'],
    blessings:['๒๓ ตุลาคม วันปิยมหาราช น้อมรำลึกพระมหากรุณาธิคุณ','น้อมรำลึกพระปิยมหาราช ด้วยความจงรักภักดี','ด้วยสำนึกในพระมหากรุณาธิคุณอันยิ่งใหญ่'] },
  constitution: { color:'#1F73C4', c2:'#0f4677', tone:'dignified blue and gold', headline:'วันรัฐธรรมนูญ', ownBlessings:true,
    subjects:['dignified Thai golden monument with clear blue morning sky, respectful national mood, no people, no text','soft blue and gold flowers with morning light, elegant calm','calm golden architecture against blue morning sky, serene national'],
    blessings:['วันรัฐธรรมนูญ ขอให้บ้านเมืองสงบสุข ร่มเย็น','๑๐ ธันวาคม วันรัฐธรรมนูญ ขอให้ทุกคนมีความสุข','ขอให้สังคมไทยเจริญก้าวหน้า สามัคคีกัน'] },
  nye: { color:'#C9A227', c2:'#7a5c12', tone:'festive gold and warm lights', headline:'ส่งท้ายปีเก่า ต้อนรับปีใหม่', ownBlessings:true,
    subjects:['warm golden new year lights and soft fireworks bokeh, festive cozy, no readable text','golden sparkles and warm celebration lights, joyful year end mood','soft glowing lanterns and golden bokeh, warm festive farewell to the old year'],
    blessings:['ส่งท้ายปีเก่าอย่างมีความสุข ต้อนรับปีใหม่ที่สดใส','ขอบคุณสำหรับปีที่ผ่านมา ขอให้ปีใหม่เป็นปีที่ดี','คืนส่งท้ายปี ขอให้ทุกความฝันเป็นจริงในปีหน้า'] },
};

// วันที่ตายตัวทุกปี (MM-DD)
const FX_FIXED = {
  '01-01': FX.newyear, '02-14': FX.valentine,
  '04-06': FX.chakri,
  '04-13': FX.songkran, '04-14': FX.songkran, '04-15': FX.songkran,
  '05-01': FX.labour, '05-04': FX.coronation,
  '06-03': FX.queen,
  '07-28': FX.king10,
  '08-12': FX.mother,
  '10-13': FX.memorial9, '10-23': FX.chulalongkorn, '10-31': FX.halloween,
  '12-05': FX.father, '12-10': FX.constitution, '12-25': FX.christmas, '12-31': FX.nye,
};
// วันที่จันทรคติ/แปรผัน (YYYY-MM-DD) — อัปเดตรายปี (ชุดนี้ปี 2026/พ.ศ.2569)
const FX_DATED = {
  '2026-01-10': FX.childrens,    // วันเด็ก (เสาร์ที่ 2 ของ ม.ค.)
  '2026-02-17': FX.cny,          // ตรุษจีน
  '2026-03-03': FX.makha,        // มาฆบูชา
  '2026-05-13': FX.plant,        // พืชมงคล
  '2026-05-31': FX.visakha,      // วิสาขบูชา
  '2026-07-29': FX.asalha,       // อาสาฬหบูชา
  '2026-07-30': FX.khaopansa,    // เข้าพรรษา
  '2026-09-25': FX.midautumn,    // ไหว้พระจันทร์
  '2026-11-25': FX.loykrathong,  // ลอยกระทง
  // ปีถัดไปเติมที่นี่
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
  const auth = POLLINATIONS_API_KEY ? `&key=${encodeURIComponent(POLLINATIONS_API_KEY)}` : '';
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`
            + `?width=${IMG_SIZE}&height=${IMG_SIZE}&nologo=true&model=${POLLINATIONS_MODEL}&seed=${seed}${auth}`;
  const imgHeaders = { 'User-Agent': 'greeting-bot' };
  if (POLLINATIONS_API_KEY) imgHeaders.Authorization = `Bearer ${POLLINATIONS_API_KEY}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    await gate();
    let res;
    try { res = await fetchT(url, { headers: imgHeaders }, IMG_TIMEOUT_MS); }
    catch (e) { lastErr = e; await sleep(2500 * (attempt + 1)); continue; }
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image')) throw new Error(`bad content-type ${ct}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4000) throw new Error('image too small');
      return buf;
    }
    lastErr = new Error(`image http ${res.status}`);
    if (![429, 500, 502, 503].includes(res.status)) break;  // error ถาวร -> เลิกลอง
    await sleep(3000 * (attempt + 1));                       // 429/5xx ชั่วคราว -> รอแล้วลองใหม่
  }
  throw lastErr || new Error('image failed');
}

// คำสั่งประเมินรูป (ใช้ร่วมกันทั้ง Pollinations และ Gemini เพื่อให้เกณฑ์ตรงกัน)
const VISION_PROMPT =
    'You are judging an image for use as a Thai "good morning" greeting card. '
  + 'Reply with EXACTLY three tokens separated by single spaces and nothing else: '
  + '<VERDICT> <SCORE> <TEXTSAFE>.\n'
  + 'VERDICT = OK or BAD. Reply BAD only if: (1) large prominent garbled text covering '
  + 'much of the image, (2) a religious figure (Buddha, Bodhisattva, deity) with severely '
  + 'distorted anatomy such as a melted face, fused or extra limbs, or grotesque rendering '
  + 'that would be disrespectful, (3) a human/figure with deformed or extra limbs, or '
  + '(4) anything disturbing or gory. A slightly imperfect statue or temple is still OK. '
  + 'Cute cartoon/3D characters, animals, children, dolls, fruits, flowers, nature, temples, '
  + 'pagodas, stupas, Buddha statues and Chinese deity statues are all OK when respectful '
  + 'and reasonably complete.\n'
  + 'SCORE = overall beauty and composition from 1 to 10 (10 = stunning, clean, well composed, '
  + 'pleasant colors; 5 = average; 1 = ugly, messy, broken, muddy). Be honest and use the full range.\n'
  + 'TEXTSAFE = Y if the central area is calm/uncluttered enough to place greeting text on top '
  + 'and still be readable, otherwise N.\n'
  + 'Example reply: OK 8 Y';

// คำสั่งประเมิน "การ์ดที่ประกอบเสร็จ" (รูป+กรอบ+ข้อความ) — ตัดสินภาพรวมที่ user เห็นจริง
const VISION_PROMPT_COMPOSITE =
    'You are judging a FINISHED Thai "good morning" greeting card that already has a photo, '
  + 'a decorative border/frame, and greeting text composited together as one design. '
  + 'Reply with EXACTLY three tokens separated by single spaces and nothing else: '
  + '<VERDICT> <SCORE> <TEXTSAFE>.\n'
  + 'VERDICT = OK or BAD. Reply BAD if: the greeting text is hard to read (low contrast or sitting on a busy area), '
  + 'the greeting text covers or overlaps the main subject\'s focal point (a face, a Buddha/deity face, an animal\'s face, the center of the main flower), '
  + 'the frame clashes badly with the photo or overlaps/cuts the text, the photo itself is broken/garbled, '
  + 'a religious figure is rendered disrespectfully (melted face, fused/extra limbs), or anything disturbing.\n'
  + 'SCORE = overall attractiveness of the FINISHED card from 1 to 10 (10 = beautiful, harmonious, very readable, '
  + 'and the text sits in clean empty space without hiding the main subject; '
  + '5 = average; 1 = ugly, unreadable, or text covering the key subject). Judge the frame, the text and the photo TOGETHER.\n'
  + 'TEXTSAFE = Y if the greeting text is clearly readable, otherwise N.\n'
  + 'Example reply: OK 8 Y';

// ด่าน 1: Pollinations (ฟรี เร็ว) — คืน {ok,score,textSafe} หรือ null ถ้าเรียกไม่สำเร็จ
async function visionPollinations(buf, prompt = VISION_PROMPT) {
  const b64 = buf.toString('base64');
  const body = {
    model: 'openai', max_tokens: 16,
    messages: [{ role:'user', content: [
      { type:'text', text: prompt },
      { type:'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
    ]}]
  };
  try {
    await gate();
    const res = await fetchT('https://text.pollinations.ai/openai',
      { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }, TXT_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content || '').trim();
    return raw ? parseAssess(raw) : null;
  } catch { return null; }
}

// ด่าน 2: Gemini (แม่นกว่า) — ใช้เฉพาะรูปก้ำกึ่ง คืน {ok,score,textSafe} หรือ null
async function visionGemini(buf, prompt = VISION_PROMPT) {
  if (!GEMINI_API_KEY) return null;
  const b64 = buf.toString('base64');
  for (const model of GEMINI_VISION_MODELS) {
    try {
      const res = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/jpeg', data: b64 } }
            ]}],
            generationConfig: { maxOutputTokens: 24, temperature: 0.2 }
          }) },
        TXT_TIMEOUT_MS);
      if (res.status === 429) { console.log(`    Gemini ${model}: 429 (เต็มโควตา) — ลองตัวถัดไป`); continue; }
      if (!res.ok) { console.log(`    Gemini ${model}: http ${res.status}`); continue; }
      const data = await res.json();
      const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (raw) return parseAssess(raw);
    } catch (e) { console.log(`    Gemini ${model} error: ${e.message}`); }
  }
  return null;
}

// ── วิเคราะห์ "แถบที่ว่างที่สุด" ของรูป (บน/ล่าง) เพื่อวางข้อความไม่ให้บังจุดสำคัญ ──
// ใช้ jpeg-js (pure JS) วัด gradient ของความสว่างต่อแถบ — แถบที่ "เรียบ" กว่า = ของสำคัญน้อยกว่า = วางข้อความได้
// fail-safe: ถ้า jpeg-js ไม่พร้อม / decode ไม่ได้ → คืน null (กลับไปใช้ตำแหน่งตาม layout เหมือนเดิม)
let _jpeg = null;
async function loadJpeg() {
  if (_jpeg !== null) return _jpeg;
  try { const m = await import('jpeg-js'); _jpeg = m.default || m; }
  catch (e) { _jpeg = false; console.log('  (ไม่มี jpeg-js — ข้ามการเลือกตำแหน่งข้อความตามภาพ)'); }
  return _jpeg;
}
async function bestTextBand(buf) {
  const jpeg = await loadJpeg();
  if (!jpeg) return null;
  let img;
  try { img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 }); }
  catch (e) { return null; }
  const { width: W, height: H, data } = img;
  if (!W || !H) return null;
  const step = Math.max(1, Math.floor(Math.min(W, H) / 160));   // subsample ~160px ด้านสั้น
  const topEnd = Math.floor(H * 0.36), botStart = Math.floor(H * 0.64); // เว้นโซนกลาง = ที่อยู่ของ subject
  const band = (y0, y1) => {
    let n = 0, g = 0;
    for (let y = y0; y < y1 - step; y += step) for (let x = 0; x < W - step; x += step) {
      const i = (y*W+x)*4, j = (y*W+x+step)*4, k = ((y+step)*W+x)*4;
      const l  = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
      const lx = 0.299*data[j]+0.587*data[j+1]+0.114*data[j+2];
      const ly = 0.299*data[k]+0.587*data[k+1]+0.114*data[k+2];
      g += Math.abs(l-lx) + Math.abs(l-ly); n++;
    }
    return n ? g/n : null;
  };
  const t = band(0, topEnd), b = band(botStart, H);
  if (t == null || b == null) return null;
  return (t < b / 1.06) ? 'top' : 'bottom';   // เอียงไป bottom เล็กน้อย (ตำแหน่งทักทายดั้งเดิม) เมื่อใกล้กัน
}

// ตัวประสาน cascade: Pollinations หยาบก่อน → คะแนนก้ำกึ่งส่ง Gemini ชี้ขาด → fallback Pollinations
async function assessImage(buf, composite = false) {
  if (!VISION) return { ok: true, score: 7, textSafe: true, src: 'off' };
  const prompt = composite ? VISION_PROMPT_COMPOSITE : VISION_PROMPT;

  // ── ด่าน 1: Pollinations ──
  const pol = await visionPollinations(buf, prompt);
  if (!pol) return { ok: true, score: 6, textSafe: true, src: 'pol-fail' }; // ล่ม → ปล่อยผ่านคะแนนกลาง
  if (!pol.ok) return { ...pol, src: 'pol' };                               // BAD ชัด → ทิ้งเลย ไม่เปลือง Gemini

  // คะแนนนอกโซนก้ำกึ่ง (ต่ำชัด/สูงชัด) → เชื่อ Pollinations เลย
  if (!GEMINI_VISION || pol.score < BORDER_LO || pol.score > BORDER_HI) return { ...pol, src: 'pol' };

  // ── ด่าน 2: ก้ำกึ่ง (BORDER_LO..BORDER_HI) → Gemini ชี้ขาด ──
  const gem = await visionGemini(buf, prompt);
  if (!gem) return { ...pol, src: 'pol(gem-fail)' };  // Gemini ล่ม/เต็มโควตา → ใช้ผล Pollinations
  return { ...gem, src: 'gemini' };
}

// แปลงคำตอบ vision เป็น { ok, score, textSafe } อย่างทนทาน
function parseAssess(raw) {
  const up = (raw || '').toUpperCase();
  const ok = !up.includes('BAD');               // มีคำว่า BAD → ไม่ผ่าน
  const m = up.match(/\b(10|[1-9])\b/);          // ตัวเลขความสวย 1-10 ตัวแรกที่เจอ
  let score = m ? parseInt(m[1], 10) : 6;        // อ่านไม่เจอ → คะแนนกลาง 6
  if (score < 1) score = 1; if (score > 10) score = 10;
  // TEXTSAFE: หา Y/N เดี่ยว ๆ (มักอยู่ท้ายสุด) — ไม่เจอถือว่าปลอดภัย
  const textSafe = /\bN\b/.test(up) && !/\bY\b/.test(up) ? false
                 : /\bY\b/.test(up) ? true : true;
  return { ok, score, textSafe };
}

async function genBlessingsGemini({ dayTh, headline, isFestival, n }) {
  const context = isFestival
    ? `วันนี้เป็น "${headline}"`
    : `วันนี้เป็นวัน${dayTh}`;

  const prompt =
    `คุณเป็นนักเขียนคำอวยพรภาษาไทยที่เข้าใจจิตใจคนไทยดี\n`
  + `${context}\n\n`
  + `แต่งคำอวยพรทักทายตอนเช้าภาษาไทย จำนวน ${n} ประโยค โดย:\n`
  + `- คละความยาว: ราวครึ่งหนึ่งให้ "สั้น กระชับ" (3-8 คำ เช่น "โชคดีมีสุข สมปรารถนา", "มั่งมี มั่งคั่ง สุขภาพดี") ที่เหลือยาวปานกลางได้ (ไม่เกิน ~20 คำ)\n`
  + `- ไม่ต้องยาวทุกประโยค ประโยคสั้น ๆ ที่ฟังดูเป็นมงคลก็ดีมาก\n`
  + `- ใช้ภาษาไทยที่ไพเราะ อ่านแล้วรู้สึกอบอุ่นใจ\n`
  + `- มีความหลากหลาย ครอบคลุมหลายธีม เช่น: สุขภาพ, ความสุข, โชคลาภ, ครอบครัว, กำลังใจ, ธรรมะ, ความสำเร็จ, ความรัก\n`
  + (isFestival
      ? `- ให้ ${Math.ceil(n * 0.6)} ประโยคอิงกับ "${headline}" และ ${Math.floor(n * 0.4)} ประโยคเป็นคำทั่วไป\n`
      : `- กระจายธีมให้ครอบคลุม ไม่ซ้ำธีมเดียวกันเกิน 3 ประโยค\n`)
  + `- ห้ามมีอิโมจิ ห้ามมีเลขลำดับ ห้ามขึ้นต้นด้วยคำว่า "สวัสดี"\n`
  + `- ห้ามซ้ำกันหรือคล้ายกันมากเกินไป\n`
  + `- ตอบกลับเป็น JSON array ของ string เท่านั้น ห้ามมี markdown หรือ backtick\n`
  + `ตัวอย่างรูปแบบที่ดี: ["ขอให้วันนี้เต็มไปด้วยรอยยิ้มและสิ่งดีๆ", "วันใหม่แห่งโอกาส ขอให้ก้าวเดินด้วยความมั่นใจ"]`;

  function parseArr(text) {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      return JSON.parse(m[0]).filter(x => typeof x === 'string' && x.trim().length > 4).map(x => x.trim());
    } catch { return []; }
  }

  // ── 1. Gemini 2.0 Flash ──
  if (GEMINI_API_KEY) {
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash']) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) { console.log(`Gemini retry หลัง delay 8 วิ...`); await new Promise(r => setTimeout(r, 8000)); }
          console.log(`gen คำอวยพร ${n} คำ ด้วย ${model}...`);
          const res = await fetchT(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
            { method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] }) },
            TXT_TIMEOUT_MS
          );
          if (res.status === 429) throw new Error(`429`);
          if (!res.ok) throw new Error(`http ${res.status}`);
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const arr = parseArr(text);
          if (arr.length < Math.floor(n * 0.5)) throw new Error(`ได้คำน้อยเกินไป (${arr.length})`);
          console.log(`✓ ${model} ได้ ${arr.length} คำ`);
          return arr;
        } catch (e) {
          const is429 = e.message.includes('429');
          console.log(`${model} error: ${e.message}${is429 && attempt < 1 ? ' — จะ retry' : ''}`);
          if (!is429) break;
        }
      }
      console.log(`${model} ไม่ได้ — ลอง model ถัดไป`);
    }
  }

  // ── 2. OpenRouter (Llama 3.3 70B) ──
  if (OPENROUTER_API_KEY) {
    try {
      console.log(`gen คำอวยพร ${n} คำ ด้วย OpenRouter (Llama)...`);
      const res = await fetchT('https://openrouter.ai/api/v1/chat/completions',
        { method:'POST',
          headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENROUTER_API_KEY}`},
          body: JSON.stringify({
            model: 'google/gemma-3-27b-it:free',
            messages:[{ role:'user', content: prompt }]
          }) },
        90000);
      if (!res.ok) throw new Error(`OpenRouter http ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      const arr = parseArr(text);
      if (arr.length < Math.floor(n * 0.5)) throw new Error(`ได้คำน้อยเกินไป (${arr.length})`);
      console.log(`✓ OpenRouter ได้ ${arr.length} คำ`);
      return arr;
    } catch (e) { console.log(`OpenRouter error: ${e.message} — fallback Pollinations`); }
  }

  // ── 3. Groq (Llama 3.3 70B — เร็วมาก free tier ใจกว้าง) ──
  if (GROQ_API_KEY) {
    try {
      console.log(`gen คำอวยพร ${n} คำ ด้วย Groq...`);
      const res = await fetchT('https://api.groq.com/openai/v1/chat/completions',
        { method:'POST',
          headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_API_KEY}`},
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages:[{ role:'user', content: prompt }],
            temperature: 0.9
          }) },
        60000);
      if (!res.ok) throw new Error(`Groq http ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      const arr = parseArr(text);
      if (arr.length < Math.floor(n * 0.5)) throw new Error(`ได้คำน้อยเกินไป (${arr.length})`);
      console.log(`✓ Groq ได้ ${arr.length} คำ`);
      return arr;
    } catch (e) { console.log(`Groq error: ${e.message} — fallback Pollinations`); }
  }

  // ── 4. Pollinations (last resort) ──
  try {
    console.log(`gen คำอวยพร ${n} คำ ด้วย Pollinations (last resort)...`);
    await gate();
    const res = await fetchT('https://text.pollinations.ai/openai',
      { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'openai', messages:[{ role:'user', content: prompt }] }) }, 90000);
    const data = await res.json();
    const arr = parseArr(data?.choices?.[0]?.message?.content || '');
    if (arr.length > 0) console.log(`✓ Pollinations ได้ ${arr.length} คำ`);
    return arr;
  } catch (e) { console.log('Pollinations error:', e.message); return []; }
}
/* ============================================================================
 * REWRITE (มิ.ย. 2569): Rolling pipeline + รูปสำเร็จ (pre-baked) + Rubric 2-AI
 * - main() ใหม่แทนของเดิม ; ฟังก์ชันช่วยทั้งหมดด้านบนคงไว้ (genImage, FX, SUBJECTS,
 *   bestTextBand, genBlessingsGemini, composite renderer)
 * - cutoff = เที่ยงคืน -> ทุกรอบสร้างชุดของ "พรุ่งนี้"
 * - เก็บเป็น output/img/<วันที่>/  (= daily-images/img/<วันที่>/) + evergreen
 * ========================================================================== */

// ── config เพิ่มสำหรับ rolling ─────────────────────────────────────────────
const RUN_BUDGET_MS     = Number(process.env.RUN_BUDGET_MS     || 85 * 60 * 1000); // หยุดเองก่อน cron รอบหน้า (90 นาที)
const PHASH_THRESHOLD   = Number(process.env.PHASH_THRESHOLD   || 6);   // ยิ่งน้อยยิ่งเข้มงวด (กันรูปซ้ำ)
const MAX_SUBJECT_REPEAT= Number(process.env.MAX_SUBJECT_REPEAT|| 3);
const MAX_PENDING_TRIES = Number(process.env.MAX_PENDING_TRIES || 3);
const MAX_GEN_PER_RUN   = Number(process.env.MAX_GEN_PER_RUN   || 200); // กัน loop หลุดเผาโควตา
const BASE_REUSE_GAP_DAYS = Number(process.env.BASE_REUSE_GAP_DAYS || 21); // base เดิมเว้นกี่วันถึงใช้ซ้ำ
const BASE_MAX_SHARE    = Number(process.env.BASE_MAX_SHARE    || (1 / 3)); // สัดส่วน base ต่อวัน
const EVERGREEN_TARGET  = Number(process.env.EVERGREEN_TARGET  || 40);
const PASS_SCORE        = Number(process.env.PASS_SCORE        || 50);  // ผ่านเมื่อคะแนนรวม "เกิน" 50/100 (เกิน 5/10)
const MIN_CLARITY       = Number(process.env.MIN_CLARITY       || 5);
const EVERGREEN_DIR     = path.join(IMG_DIR, 'evergreen');

// ── ตัวเรียก vision สำหรับ rubric (คืน "ข้อความดิบ" ให้ lib/rubric parse JSON เอง) ──
// ต่างจาก visionPollinations/visionGemini เดิมที่ parse เป็น OK/BAD — อันนี้ขอ JSON 5 ข้อ
async function visionPollRubric(buf, prompt) {
  const b64 = buf.toString('base64');
  await gate();
  const polHeaders = { 'Content-Type': 'application/json' };
  if (POLLINATIONS_API_KEY) polHeaders.Authorization = `Bearer ${POLLINATIONS_API_KEY}`;
  const res = await fetchT('https://text.pollinations.ai/openai',
    { method: 'POST', headers: polHeaders,
      body: JSON.stringify({ model: 'openai', max_tokens: 120,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
        ]}] }) },
    TXT_TIMEOUT_MS);
  if (!res.ok) throw new Error('pol http ' + res.status);
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}
async function visionGemRubric(buf, prompt) {
  if (!GEMINI_API_KEY) throw new Error('no GEMINI_API_KEY');
  const b64 = buf.toString('base64');
  for (const model of GEMINI_VISION_MODELS) {
    try {
      const res = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/jpeg', data: b64 } }
            ]}],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 400,
              responseMimeType: 'application/json',     // บังคับ JSON ล้วน (แก้ no-json)
              responseSchema: {
                type: 'object',
                properties: {
                  clarity: { type: 'integer' }, appropriateness: { type: 'integer' },
                  beauty: { type: 'integer' }, warmth: { type: 'integer' }, quality: { type: 'integer' }
                },
                required: ['clarity', 'appropriateness', 'beauty', 'warmth', 'quality']
              },
              thinkingConfig: { thinkingBudget: 0 }       // ปิด reasoning (แก้ timeout/abort + ตอบว่าง)
            }
          }) },
        GEM_TIMEOUT_MS);
      if (res.status === 429 || !res.ok) continue;
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const raw = parts.map(x => x?.text).filter(Boolean).join('').trim();
      if (raw) return raw;
    } catch (e) { /* ลองโมเดลถัดไป */ }
  }
  throw new Error('gemini vision failed');
}

// ── state helpers (manifest ต่อวัน + base bank + evergreen) ────────────────
function loadManifest(dir, meta) {
  const f = path.join(dir, 'manifest.json');
  if (fs.existsSync(f)) {
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      return { images: [], pending: [], usedSeeds: [], hashes: [], subjectCount: {}, blessings: [], ...m };
    } catch (e) { /* เสีย -> เริ่มใหม่ */ }
  }
  return { ...meta, images: [], pending: [], usedSeeds: [], hashes: [], subjectCount: {}, blessings: [], version: String(Date.now()) };
}
function saveManifest(dir, st) {
  fs.mkdirSync(dir, { recursive: true });
  const images = [...st.images].sort((a, b) => (b.score || 0) - (a.score || 0)); // เว็บโชว์คะแนนสูงก่อน
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ ...st, images, count: images.length, version: String(Date.now()) }, null, 2));
}
function loadBank() {
  const f = path.join(EVERGREEN_DIR, 'bank.json');
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {} }
  return { bases: [] }; // [{ id, raw(file), lastUsed(ISO|null), uses }]
}
function saveBank(b) {
  fs.mkdirSync(EVERGREEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVERGREEN_DIR, 'bank.json'), JSON.stringify(b, null, 2));
}
function loadEver() {
  const f = path.join(EVERGREEN_DIR, 'manifest.json');
  if (fs.existsSync(f)) { try { return { images: [], hashes: [], ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (e) {} }
  return { images: [], hashes: [] };
}
function saveEver(e) {
  fs.mkdirSync(EVERGREEN_DIR, { recursive: true });
  const images = [...e.images].sort((a, b) => (b.score || 0) - (a.score || 0));
  fs.writeFileSync(path.join(EVERGREEN_DIR, 'manifest.json'),
    JSON.stringify({ ...e, images, count: images.length }, null, 2));
}
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

// ── main ใหม่ (rolling) ────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  const timeLeft = () => RUN_BUDGET_MS - (Date.now() - start);

  // cutoff = เที่ยงคืน -> ระหว่างวันนี้สร้างชุดของ "พรุ่งนี้" (live ตอนเที่ยงคืน)
  const ict = nowICT();
  const liveISO = isoDate(ict);
  // กันหน้าว่าง: ถ้าชุดของ "วันนี้" ยังไม่ครบ -> สร้างของวันนี้ก่อนเลย ; ครบแล้วค่อยทำของพรุ่งนี้ (ทำงานล่วงหน้า)
  let todayHave = 0;
  try { const tm = JSON.parse(fs.readFileSync(path.join(IMG_DIR, liveISO, 'manifest.json'), 'utf8')); todayHave = (tm.images || []).length; } catch (e) {}
  const tgt = todayHave < TARGET ? ict : new Date(ict.getTime() + 24 * 3600 * 1000);
  const targetISO = isoDate(tgt);
  const dayTheme = DAYS[tgt.getUTCDay()];
  const fest = getFestival(targetISO);
  const theme = fest ? { ...dayTheme, ...fest } : dayTheme;
  const headline = fest ? fest.headline : `สวัสดีวัน${dayTheme.th}`;
  const dateThai = `วัน${dayTheme.th} ที่ ${tgt.getUTCDate()} ${THAI_MONTHS[tgt.getUTCMonth()]} ${tgt.getUTCFullYear() + 543}`;

  fs.mkdirSync(IMG_DIR, { recursive: true });

  // prune: เก็บแค่ liveISO (วันนี้, live) + targetISO (พรุ่งนี้, กำลังสร้าง) + evergreen
  const tomorrowISO = isoDate(new Date(ict.getTime() + 24 * 3600 * 1000));
  const keep = [...new Set([liveISO, tomorrowISO])];
  for (const name of fs.readdirSync(IMG_DIR)) {
    if (name === 'evergreen') continue;
    const p = path.join(IMG_DIR, name);
    try { if (fs.statSync(p).isDirectory() && !keep.includes(name)) { fs.rmSync(p, { recursive: true, force: true }); console.log('[prune]', name); } }
    catch (e) {}
  }

  const dir = path.join(IMG_DIR, targetISO);
  fs.mkdirSync(dir, { recursive: true });
  const st = loadManifest(dir, {
    date: targetISO, dateThai, dayTh: dayTheme.th, dayEn: dayTheme.en, headline,
    isFestival: !!fest, festival: fest ? fest.headline : null, color: theme.color, color2: theme.c2,
  });

  console.log(`=== [rolling] ICT ${liveISO} -> target ${targetISO} (${dayTheme.th})${fest ? ' [เทศกาล]' : ''} | มี ${st.images.length}/${TARGET} ค้างตรวจ ${st.pending.length} ===`);

  // คลังคำอวยพร: gen ครั้งเดียวต่อวัน เก็บใน manifest แล้วใช้ซ้ำข้ามรอบ
  if (fest && fest.ownBlessings && fest.blessings && fest.blessings.length) {
    st.blessings = fest.blessings; // วันสำคัญ/วันรำลึก: ใช้คำของวันนั้นโดยตรง (ไม่ gen โทนรื่นเริง)
    saveManifest(dir, st);
    console.log(`✓ ใช้คำของ ${headline} ${st.blessings.length} คำ`);
  } else if (!st.blessings || st.blessings.length < TARGET) {
    try {
      const bl = await genBlessingsGemini({ dayTh: dayTheme.th, headline, isFestival: !!fest, n: TARGET });
      if (bl && bl.length) st.blessings = bl;
    } catch (e) { console.log('blessings gen fail:', e.message); }
    if (!st.blessings || !st.blessings.length)
      st.blessings = ['ขอให้เป็นวันที่สดใส', 'ขอให้มีความสุขทุกวัน', 'สุขภาพแข็งแรงนะคะ', 'โชคดีมีสุข สมปรารถนา'];
    saveManifest(dir, st);
    console.log(`✓ คำอวยพร ${st.blessings.length} คำ`);
  }
  const pickBl = (i) => st.blessings[i % st.blessings.length];

  // composite = ทางหลัก (รูปสำเร็จ) — ถ้าเปิดไม่ได้ จบรอบนี้ (ไม่มีรูปสำเร็จให้ส่งมอบ)
  let renderer, rCounts;
  try {
    const { CompositeRenderer } = await import('./composite.mjs');
    renderer = new CompositeRenderer(INDEX_HTML_PATH);
    await renderer.init();
    rCounts = await renderer.page.evaluate(() => ({ frames: FRAMES.length, layouts: LAYOUTS.length, texts: TEXT_SIZES.length, overlays: OVERLAYS.length }));
    console.log(`✓ composite พร้อม (frames=${rCounts.frames} layouts=${rCounts.layouts})`);
  } catch (e) {
    console.log(`✗ เปิด composite ไม่สำเร็จ (${e.message}) — จบรอบ (ต้องมี Puppeteer/Chromium)`);
    if (renderer) { try { await renderer.close(); } catch (x) {} }
    return;
  }

  const panel = (cardBuf) => scorePanel(cardBuf, [
    { name: 'pollinations', fn: visionPollRubric },
    { name: 'gemini', fn: visionGemRubric },
  ], { passScore: PASS_SCORE, minClarity: MIN_CLARITY, minVoters: MIN_VOTERS });

  const renderCard = async ({ raw, blessing, withDay }) => {
    const band = await bestTextBand(raw);
    return renderer.render({
      imgDataUrl: `data:image/jpeg;base64,${raw.toString('base64')}`,
      frameIdx: Math.floor(Math.random() * rCounts.frames),
      layoutIdx: Math.floor(Math.random() * rCounts.layouts),
      txIdx: Math.floor(Math.random() * rCounts.texts),
      ovIdx: Math.floor(Math.random() * rCounts.overlays),
      headline: withDay ? headline : '',           // evergreen: ไม่ใส่บรรทัด "สวัสดีวัน..."
      blessing, dateThai: withDay ? dateThai : '',
      color: (withDay ? theme.color : dayTheme.color),
      color2: (withDay ? theme.c2 : dayTheme.c2),
      dayTh: withDay ? dayTheme.th : '', size: 800, vp: band || null,
    });
  };

  let gens = 0;

  // 1) ตรวจของค้างก่อน (ไม่ต้อง gen ใหม่)
  const stillPending = [];
  for (const it of st.pending) {
    if (timeLeft() < 60000) { stillPending.push(it); continue; }
    const fp = path.join(dir, it.file);
    if (!fs.existsSync(fp)) continue;
    const r = await panel(fs.readFileSync(fp));
    if (r.decision === 'keep') {
      st.images.push({ file: it.file, score: r.score, blessing: it.blessing, baseId: it.baseId || null, src: it.src || null });
      console.log(`  ✓ recheck keep ${it.file} (${r.score})`);
    } else if (r.decision === 'pending' && (it.tries || 0) + 1 < MAX_PENDING_TRIES) {
      stillPending.push({ ...it, tries: (it.tries || 0) + 1 });
    } else {
      fs.rmSync(fp, { force: true });
      console.log(`  ✗ recheck drop ${it.file} (${r.reason})`);
    }
  }
  st.pending = stillPending;
  saveManifest(dir, st);

  // 2) สร้างเพิ่มจนครบ target
  const bank = loadBank();
  const baseBudget = Math.floor(TARGET * BASE_MAX_SHARE);
  let baseUsed = st.images.filter(i => i.baseId).length;

  while (st.images.length < TARGET && timeLeft() > 90000 && gens < MAX_GEN_PER_RUN) {
    gens++;
    const blessing = pickBl(st.images.length);
    let raw, baseId = null, seed = null, subject = null, hash, src = null;

    const elig = bank.bases.filter(b => !b.lastUsed || daysBetween(b.lastUsed, targetISO) >= BASE_REUSE_GAP_DAYS);
    const useBank = baseUsed < baseBudget && elig.length > 0 && Math.random() < 0.4; // บางครั้งดึง base มาเร่ง

    try {
      if (useBank) {
        const b = elig[Math.floor(Math.random() * elig.length)];
        raw = fs.readFileSync(path.join(EVERGREEN_DIR, b.raw));
        baseId = b.id; src = b.src || null;
      } else if (photosEnabled() && Math.random() < PHOTO_SHARE) {
        // รูปถ่าย royalty-free (ดอกไม้/ต้นไม้/สถานที่ ไม่มีคน) — ใส่เครดิตผ่านปุ่ม i ในเว็บ
        try {
          const ph = await fetchStockPhoto(fetchT, TXT_TIMEOUT_MS);
          raw = ph.buffer; src = ph.src;
          console.log(`[${gens}] photo "${src.name}" by ${src.by} (${st.images.length}/${TARGET})`);
        } catch (e) { console.log('  (photo fail):', e.message); }
      }
      if (!raw) {
        if (fest && Math.random() < FEST_SUBJECT_RATIO) subject = fest.subjects[Math.floor(Math.random() * fest.subjects.length)];
        else subject = pickSubject(theme);
        if ((st.subjectCount[subject] || 0) >= MAX_SUBJECT_REPEAT) continue;
        do { seed = Math.floor(Math.random() * 1e9); } while (st.usedSeeds.includes(seed));
        const prompt = `${subject}, ${theme.tone} color palette, soft golden morning light, dreamy, elegant, highly detailed, beautiful, no text, no letters, no numbers, no watermark, no signature`;
        console.log(`[${gens}] gen seed=${seed} (${st.images.length}/${TARGET})`);
        raw = await genImage(prompt, seed);
      }
    } catch (e) { console.log('  ! gen:', e.message); continue; }

    // dedup ก่อน composite (ประหยัด)
    try { hash = dhash(raw); } catch (e) { continue; }
    if (isDuplicate(hash, st.hashes, PHASH_THRESHOLD)) {
      if (seed != null) st.usedSeeds.push(seed);
      console.log('  ↺ รูปซ้ำ ทิ้ง');
      continue;
    }

    // composite = การ์ดสำเร็จ
    let card;
    try { card = await renderCard({ raw, blessing, withDay: true }); }
    catch (e) { console.log('  ! render:', e.message); continue; } // render พัง = ข้ามรูปนี้ (ไม่ fallback รูปดิบ)
    if (!card || card.length < 2000) { console.log('  ! render เล็กผิดปกติ'); continue; }

    const fname = `card_${Date.now()}_${gens}.jpg`;
    fs.writeFileSync(path.join(dir, fname), card);
    const r = await panel(card);

    st.hashes.push(hashToStr(hash));
    if (seed != null) st.usedSeeds.push(seed);
    if (subject) st.subjectCount[subject] = (st.subjectCount[subject] || 0) + 1;

    if (r.decision === 'keep') {
      st.images.push({ file: fname, score: r.score, blessing, baseId, src });
      if (baseId) { baseUsed++; const b = bank.bases.find(x => x.id === baseId); if (b) { b.lastUsed = targetISO; b.uses = (b.uses || 0) + 1; } }
      console.log(`  ✓ keep ${fname} (${r.score})`);
    } else if (r.decision === 'pending' && src && PHOTO_TRUST_NOVOTE && (r.perAI||[]).every(a => !a.scores)) {
      // รูปถ่าย royalty-free (curated, ปลอดภัย) + AI ล่มหมด (0 โหวต) -> ผ่านได้ กันหน้าว่าง (ตั้ง PHOTO_TRUST_NOVOTE=0 เพื่อปิด)
      st.images.push({ file: fname, score: 60, blessing, baseId, src });
      console.log(`  ✓ keep(photo, AI ล่ม) ${fname}`);
    } else if (r.decision === 'pending') {
      st.pending.push({ file: fname, blessing, baseId, seed, src, tries: 0 });
      console.log(`  … pending ${fname} (${r.reason}) [${(r.perAI||[]).map(a=>`${a.name}:${a.error?('ERR '+a.error):(a.scores?'ok':'no-json')}`).join(' | ')}]`);
    } else {
      fs.rmSync(path.join(dir, fname), { force: true });
      console.log(`  ✗ reject ${fname} (${r.reason}) [${(r.perAI||[]).map(a=>`${a.name}:${a.error?('ERR '+a.error):(a.scores?'ok':'no-json')}`).join(' | ')}]`);
    }
    saveManifest(dir, st);
  }

  saveBank(bank);
  saveManifest(dir, st);

  // 3) ฉวยโอกาสเติม evergreen + base bank (ครบ target แล้วและยังเหลือเวลา)
  if (st.images.length >= TARGET) {
    const ever = loadEver();
    const NEUTRAL = ['สวัสดีค่ะ ขอให้เป็นวันที่ดี', 'ขอให้มีความสุขทุกวัน', 'สุขภาพแข็งแรงนะคะ', 'คิดถึงและห่วงใยเสมอ', 'ขอให้โชคดีมีความสุข'];
    while (ever.images.length < EVERGREEN_TARGET && timeLeft() > 120000 && gens < MAX_GEN_PER_RUN) {
      gens++;
      const subject = pickSubject(dayTheme);
      const seed = Math.floor(Math.random() * 1e9);
      let raw;
      try { raw = await genImage(`${subject}, soft golden morning light, dreamy, elegant, highly detailed, beautiful, no text, no letters, no numbers, no watermark`, seed); }
      catch (e) { continue; }
      let h; try { h = dhash(raw); } catch (e) { continue; }
      if (isDuplicate(h, ever.hashes, PHASH_THRESHOLD)) continue;

      const blessing = NEUTRAL[Math.floor(Math.random() * NEUTRAL.length)];
      let card;
      try { card = await renderCard({ raw, blessing, withDay: false }); } catch (e) { continue; }
      if (!card || card.length < 2000) continue;
      const r = await panel(card);
      if (r.decision !== 'keep') continue;

      const rawName = `base_${Date.now()}_${gens}.jpg`;   // raw ไว้ re-skin วันอื่น
      const cardName = `ever_${Date.now()}_${gens}.jpg`;  // finished neutral สำหรับ fallback
      fs.mkdirSync(EVERGREEN_DIR, { recursive: true });
      fs.writeFileSync(path.join(EVERGREEN_DIR, rawName), raw);
      fs.writeFileSync(path.join(EVERGREEN_DIR, cardName), card);
      bank.bases.push({ id: rawName, raw: rawName, lastUsed: null, uses: 0, src: null });
      ever.images.push({ file: cardName, score: r.score });
      ever.hashes.push(hashToStr(h));
      saveBank(bank); saveEver(ever);
      console.log(`  ✓ evergreen +1 (${ever.images.length}/${EVERGREEN_TARGET})`);
    }
  }

  try { await renderer.close(); } catch (e) {}
  saveManifest(dir, st);
  console.log(`=== [done] target ${targetISO} เก็บ ${st.images.length}/${TARGET} ค้าง ${st.pending.length} gens ${gens} เหลือเวลา ${Math.round(timeLeft() / 1000)}s ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
