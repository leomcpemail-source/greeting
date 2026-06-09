// scripts/generate.mjs
// รันโดย GitHub Actions ตอนดึก: gen รูปธีมตามวัน + กรองรูปแปลก + จัดการคลังคำอวยพร
// ใช้ fetch/fs ในตัวของ Node 20

import fs from 'node:fs';
import path from 'node:path';
import { dhash, isDuplicate, hashToStr } from './lib/phash.mjs';
import { scorePanel } from './lib/rubric.mjs';
import { photosEnabled, fetchStockPhoto, dayFlowerQueries } from './lib/photos.mjs';

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
const PHOTO_SHARE = Number(process.env.PHOTO_SHARE || 0.50);          // สัดส่วนใช้รูปถ่าย Pexels — ลดลง (Pollen กลับมาแล้ว มิ.ย.2569: 0.92→0.50 ให้ AI gen มากขึ้น)
const PHOTO_TRUST_NOVOTE = (process.env.PHOTO_TRUST_NOVOTE || '1') !== '0'; // รูปถ่าย curated: ถ้า AI ล่มหมด (0 โหวต) ให้ผ่านได้ (กันหน้าว่าง)
const USE_POLL_VISION = (process.env.USE_POLL_VISION || '1') === '1';   // vision ฝั่ง Pollinations — เปิดเป็นค่าเริ่มต้น (Pollen กลับมาแล้ว มิ.ย.2569) ปิดได้ด้วย env USE_POLL_VISION=0
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

// สีกลาง (ไร้วัน) สำหรับรูปคลังหมวด/evergreen — ห้ามผูกกับสีประจำวัน ไม่งั้นหน้าหมวดจะดูเหมือน "ภาพวันพุธ"
const NEUTRAL_COLOR  = '#3a2a34';
const NEUTRAL_COLOR2 = '#241820';

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
  t => `majestic golden chedi stupa with blue sky and clouds, Thai Buddhist temple, serene morning, no people, no text`,
  t => `beautiful Thai temple entrance gate with intricate golden decorations, sunlight, peaceful, no text`,
  t => `a serene Buddha footprint shrine with flower offerings and golden light, temple courtyard, no people, no text`,
  t => `tall golden standing Buddha statue in a peaceful Thai temple garden at sunrise, surrounded by trees, no text`,
  t => `Thai temple with ornate mosaic walls reflecting morning sunlight, lush garden, peaceful, no people`,
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
  t => `a tall golden standing Buddha statue in front of a white Thai temple, centered on a clean ${t.tone} toned background, symmetrical, generous sky space, soft morning glow, respectful, no text`,
  t => `a gilded Thai Buddha image with intricate golden patterns on an ornate throne, centered on a rich ${t.tone} background, divine soft glow, no text`,
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


// ── CATEGORY_SUBJECTS — prompt ตามหมวด สำหรับระบบ category ──────────────
const CATEGORY_SUBJECTS = {
  flowers: [
    'a gorgeous photographic arrangement of pink roses and peonies with soft bokeh, morning light',
    'macro photograph of a vibrant sunflower with dewdrops, bright golden center, soft background',
    'a beautiful photographic bouquet of mixed wildflowers in soft pastel tones, natural light',
    'elegant white orchid on dark background, macro, soft studio lighting',
    'a field of lavender in full bloom stretching to the horizon, purple haze, golden hour',
    'cherry blossom branch full of pink petals against soft blue sky, spring morning',
    'a colorful photographic garden with tulips and daisies in pastel morning light',
    'a single perfect red rose with water droplets, dark bokeh background, macro',
    'lotus flowers blooming in a calm pond, pink and white, morning light reflection',
    'a rustic vase of garden flowers on a white marble surface, natural window light',
    'close-up of a dahlia with many intricate petals, vibrant color, macro photography',
    'a dreamy field of daisies at golden hour, soft focus, warm sunlight',
    'tropical plumeria frangipani flowers on green leaves, fresh and vibrant, close-up',
    'a bouquet of pastel hydrangeas in soft morning light, romantic mood',
    'marigold flowers in warm orange and gold tones, festive, closeup',
    'delicate jasmine flowers with green leaves, fresh and pure, soft natural light',
    'a photographic flower crown of mixed blooms, flat lay on white, elegant',
    'morning glory flowers climbing a garden fence, blue purple, dewy morning',
    'a cascading arrangement of wisteria blossoms, purple and soft, dreamy light',
    'bird of paradise flower in vibrant orange and blue, tropical, dramatic light',
    'sweet peas in soft pink and purple tones, flowing petals, bright garden light',
    'a beautiful flat lay of dried flowers and herbs on white linen, minimalist',
    'chrysanthemum flowers in various colors, traditional Thai festive style',
    'a close-up of passion flower with intricate purple details, macro photography',
    'yellow mimosa flowers in soft spring light, golden and cheerful',
    'a bunch of peonies in full bloom, lush and soft, pastel tones',
    'water lily floating on a still pond, pink and white, serene reflection',
    'sunflowers in a summer field, bright yellow, blue sky, joyful',
    'purple irises with golden stamens, elegant and refined, natural light',
    'a heart-shaped arrangement of rose petals on white, romantic, overhead view',
  ],
  dharma: [
    'serene golden Buddha statue glowing softly, lotus flowers, temple garden, morning mist, no text',
    'ancient Thai Buddhist temple with golden pagoda at sunrise, still water reflection, no people',
    'a glowing Buddhist altar with candles, lotus flowers, and incense smoke, peaceful temple',
    'Buddhist dharma wheel symbol in golden light on a temple wall, ornate, respectful',
    'rows of golden Buddha amulet pendants, warm light, devotional, close-up',
    'a serene Buddha footprint shrine with flower offerings and candles, no people',
    'tall golden chedi stupa with blue sky and clouds, Thai Buddhist temple, morning',
    'lotus bud offering on a golden temple floor, morning light, devotional, no people',
    'a monk meditating under a Bodhi tree at dawn, silhouette, peaceful',
    'Thai temple monks receiving alms in early morning golden light, serene street scene',
    'majestic golden reclining Buddha statue in a temple hall, soft light, no people',
    'Buddhist monks walking with umbrellas in a Thai temple courtyard, serene, morning',
    'a beautiful lotus in full bloom floating on still water, golden light, serene',
    'an old wooden Buddhist shrine with candles and flowers, rustic, warm glow',
    'a row of temple bells with ornate decorations, golden morning light, no people',
    'white sacred stupa surrounded by tropical trees, golden light, peaceful sky',
    'Thai temple gate with golden naga serpent decorations, morning light, grand',
    'a simple monk bowl with a single lotus flower, minimalist, serene',
    'lanterns floating upward at a temple festival, bokeh lights, magical night',
    'an ornate golden Buddhist manuscript book with decorations, cultural, respectful',
    'a Buddha statue hands in dhyana mudra, close-up, golden, peaceful',
    'incense sticks burning with smoke curling upward, golden temple background, bokeh',
    'a golden Buddha image seated on a lotus with flower garlands, soft divine light',
    'symmetrical Thai temple facade with golden spires at dawn, majestic, no people',
    'a handmade merit boat with candles and lotus, floating on water at night',
    'morning alms round of monks in orange robes, street lined with devotees, soft light',
    'a prayer book and lotus flowers on a temple floor, simple, devotional',
    'monk feet in orange sandals on a temple path with fallen petals, contemplative',
    'a serene Buddha face in meditation, golden sculpture, soft backlight, respectful',
    'a Thai temple mural painting depicting Jataka stories, vibrant colors, artistic',
  ],
  inspire: [
    'a sunrise breaking over mountains with vibrant golden colors, new beginning, hopeful',
    'a single tree on a hill in golden morning light, strength and solitude, majestic',
    'a road stretching into the horizon through autumn leaves, journey, photographic',
    'a lighthouse standing tall against stormy waves, strength, determination, dramatic',
    'a butterfly emerging from a cocoon, transformation, hope, macro photography',
    'a young green sprout breaking through dry soil, life and resilience, macro',
    'a lone eagle soaring above mountain peaks in golden light, freedom, power',
    'a sunrise over a calm sea with warm pastel colors, hope and new beginnings',
    'a dandelion seed head with seeds drifting on the wind, wishes, soft light, macro',
    'a candle flame burning bright in darkness, hope, warmth, close-up bokeh',
    'a path winding through a beautiful forest in autumn colors, journey of life',
    'a sunrise between two mountains with a river below, new day, fresh start',
    'wildflowers pushing through cracks in a stone wall, resilience and beauty',
    'a rainbow after rain over green fields, hope and beauty after difficulty',
    'a hot air balloon ascending over misty morning valleys, adventure, freedom',
    'a stream of light entering a dark cave opening, hope, finding your way',
    'stones stacked in a balanced cairn by a river, harmony and patience',
    'a sunrise mirrored in still water, symmetry, peace and reflection',
    'a kite soaring high against a blue sky with clouds, freedom, uplifting mood',
    'morning sunlight filtering through forest leaves, hope and warmth',
    'a starfield above a mountain silhouette, vast possibilities, wonder',
    'a boat setting sail on calm morning waters, new journey, adventurous',
    'lotus flowers rising from muddy water into sunlight, overcoming adversity',
    'an open book with flowers growing from the pages, knowledge and growth',
    'footprints in sand leading toward the ocean sunrise, journey, hope',
    'bamboo grove in morning mist, strength and flexibility, serene mood',
    'a compass on an old map, guidance and direction, warm light, adventurous',
    'a child reaching up toward a floating balloon, dreams and aspirations',
    'a majestic sunrise over rice fields, golden light, rural Thailand, inspiring',
    'a single candle in vast darkness, small light, huge hope, minimalist',
  ],
  miss: [
    'a beautiful heart made of rose petals on white, love and affection, overhead',
    'two mugs of coffee side by side on a cozy table, companionship, warm morning',
    'a handwritten letter with a dried flower pressed inside, nostalgia, warmth',
    'a bouquet of red and pink roses tied with ribbon, love, romantic light',
    'two rocking chairs on a porch at sunset, togetherness, warmth',
    'a window with rain outside and a cozy lamp glowing inside, missing someone',
    'two trees with intertwining branches, together forever, golden light',
    'a pair of hands holding a small heart figurine, affection, warm tone',
    'pink tulips in a soft morning window, tender feelings, pastel mood',
    'a love letter envelope with wax seal and dried flowers, longing, vintage',
    'a sunset reflection in a still pond, golden and nostalgic, peaceful',
    'hearts shaped in foam latte art in two mugs, coffee love',
    'a red rose in a vase by a rainy window, longing and warmth',
    'a pair of small bird figurines perched together, companionship, cute',
    'a photo album open with flowers beside it, memories and nostalgia',
    'a romantic garden path with roses on either side at sunset',
    'pastel pink roses with soft morning bokeh, gentle feelings, romantic',
    'a single red thread tied around a pinky finger, fate and connection',
    'two teacups with matching patterns side by side, comfort, warm tone',
    'a message in a bottle on a beach at sunrise, longing, poetic',
    'friendship bracelets woven together in bright colors, bond and togetherness',
    'two sparrows on a telephone wire against sunrise sky, together',
    'a butterfly landing on a flower, delicate connection, soft light',
    'a starry sky above a field with one glowing lantern, missing at night',
    'lavender sachets tied with ribbon, fragrance and memory, soft pastel',
    'a moonlit night with flowers on a windowsill, longing, romantic mood',
    'a small gift wrapped in pretty paper with a bow, anticipation, warm tones',
    'an old telephone with dried roses beside it, nostalgia, missing someone',
    'a couple initials carved in a tree, love, warm forest light',
    'a sunrise viewed from a window with a coffee cup, waiting for someone',
  ],
  birthday: [
    'a beautiful birthday cake with lit candles on a pastel background, celebration',
    'colorful balloons floating against a pastel sky, festive birthday mood',
    'a festive birthday table spread with cake, flowers and gifts, celebration',
    'a cheerful birthday banner with flowers and bokeh lights, party atmosphere',
    'a whimsical birthday cupcake with sprinkles and a candle, kawaii style',
    'colorful confetti falling in soft golden light, festive celebration',
    'a pastel birthday flat lay with macarons, flowers, and ribbon, elegant',
    'birthday sparklers with golden sparks on a dark background, magical',
    'a stack of prettily wrapped gift boxes tied with ribbon, birthday gifts',
    'a festive garland of bunting flags in pastel colors, birthday decoration',
    'a birthday cake with flowers and gold drizzle, sophisticated, flat lay',
    'balloons in heart shape against blue sky, birthday love, joyful',
    'a close-up of birthday candles burning, warm glow, bokeh background',
    'a giant number balloon in gold against a marble background, stylish birthday',
    'a donut tower with sprinkles and candles, fun birthday treat',
    'rainbow macarons arranged in a circle, colorful birthday treat',
    'a letter board with birthday message surrounded by flowers, celebration',
    'an elegant champagne flute with sparklers, birthday toast, golden',
    'a surprise confetti box opening with confetti flying, birthday surprise',
    'a birthday wreath of flowers and ribbons, whimsical and charming',
    'a 3D cartoon birthday scene with cute characters celebrating, kawaii Pixar',
    'birthday fireworks over a park at night, festive, colorful',
    'a beautiful birthday cake with edible flowers, elegant, pastel tones',
    'a collection of birthday cards and flowers, warm and sentimental',
    'a birthday picnic setup in a garden with flowers and food, joyful',
    'gold foil balloon letters, festive birthday, on white minimal background',
    'birthday candles reflected in mirror, golden glow, artistic',
    'a big beautiful birthday gift with a bow, anticipation and joy',
    'a cheerful 3D cartoon child blowing birthday candles, kawaii wholesome',
    'flowers and sparkly birthday decorations on a pastel table, dreamy',
  ],
  elderly: [
    'a pair of elderly hands gently holding a cup of tea, warm and tender, macro',
    'an elderly couple walking hand in hand in a garden at sunrise, golden light',
    'a serene older woman tending to her garden of flowers, peaceful morning',
    'grandparents with grandchildren in a sunlit garden, joyful family moment',
    'an elderly person meditating peacefully in nature, serenity and calm',
    'a cozy reading corner with a rocking chair, warm lamp, and books',
    'an older couple sharing tea at sunrise on a wooden porch, contentment',
    'a gardening hat and gloves beside flowering plants, gentle morning gardening',
    'a temple where an elderly devotee offers flowers at dawn, reverent, peaceful',
    'a wisdom tree an ancient gnarled tree with lush canopy, majestic',
    'a shelf with family photos and flowers, warm nostalgic atmosphere',
    'hands clasped in prayer near golden candlelight, devotion and peace',
    'an older couple dancing slowly in a golden-lit garden, romance',
    'a grandmother kitchen with fresh herbs, warmth and nourishment',
    'a pot of jasmine tea and jasmine flowers, Thai elder lifestyle, gentle',
    'grandchildren bringing flowers to grandparents, silhouette at sunrise',
    'a golden path through autumn trees, representing life journey',
    'a peaceful hammock in a garden with flowers, restful afternoon',
    'an elder hands arranging fresh flowers in a vase, caring and artistic',
    'a golden sunset walk silhouette of elderly couple, serene beach',
    'morning tai chi silhouettes in a misty park, health and longevity',
    'a bowl of traditional Thai desserts prepared with love, nourishing',
    'a senior-friendly flower garden with easy paths, beautiful and serene',
    'a joyful elder laughing softly in a sunlit garden, candid, not too close',
    'elder hands writing calligraphy with ink brush, wisdom and skill',
    'a family gathering with multiple generations under a tree, warm light',
    'a pair of reading glasses beside books and flowers, intellectual elder',
    'a rocking chair with a knitting basket on a sunny porch, peaceful',
    'jasmine garlands made with elder hands, Thai culture, morning ritual',
    'a couple of seniors watching sunrise from a hilltop, life milestone',
  ],
  health: [
    'a healthy breakfast bowl with colorful fruits and granola, fresh morning',
    'a glass of water with lemon slices and mint, fresh and refreshing',
    'yoga pose at sunrise outdoors, wellness, peaceful morning practice',
    'fresh green vegetables and herbs arranged on white surface, healthy eating',
    'a stethoscope with a heart shape, health and care, soft background',
    'running shoes on a sunny path, fitness motivation, morning light',
    'a colorful smoothie bowl with fruits and seeds, healthy food photography',
    'a serene nature walk path with trees and morning light, healthy life',
    'meditation hands on lap in nature, mental health and calm, close-up',
    'a beautiful herbal tea cup with flowers, wellness and self-care',
    'fresh fruits in a basket in morning light, abundant and nourishing',
    'a person stretching in morning sunlight, flexibility, wellbeing',
    'a bowl of traditional Thai herbal medicine soup, wellness',
    'green juice and vegetables, morning health ritual, vibrant colors',
    'a spa setting with flowers and candles, relaxation and rejuvenation',
    'Thai herbal compress ball with flowers and herbs, wellness treatment',
    'a bicycle leaning against a tree on a sunny path, active lifestyle',
    'fresh ginger, lemon and honey in a mug, natural remedy, warm',
    'lavender essential oil with flowers, aromatherapy, calm mood',
    'a morning walk footprints in dew-covered grass, fresh start',
    'hands cupping a small green plant sprout, nurturing life and health',
    'a doctor white coat with a stethoscope, care and dedication',
    'healthy Thai food on a beautiful wooden table, fresh and balanced',
    'a morning run silhouette against a sunrise, determination and health',
    'fresh herbs growing in pots on a sunny windowsill, natural pharmacy',
    'a peaceful swimming pool at sunrise, exercise and relaxation',
    'lotus root and vegetables in a Thai herbal market, traditional wellness',
    'colorful vitamin supplements on white, health consciousness',
    'Thai traditional massage oil and spa accessories, wellness and care',
    'a clear sunrise over a calm lake, metaphor for health and clarity',
  ],
  festival: [
    'colorful Songkran water festival with splashing water and flowers, joyful Thai new year',
    'lanterns floating in the sky at Loy Krathong festival, magical night',
    'a beautiful Thai New Year decoration with jasmine garlands, festive',
    'Chinese New Year red lanterns and gold ingots, festive and lucky',
    'a Christmas tree decorated with lights and ornaments, festive warmth',
    'fireworks over a city skyline on New Year Eve, celebration',
    'a candlelit Buddhist merit ceremony at a temple, solemn and beautiful',
    'colorful confetti and party streamers, general festival celebration',
    'a Thai temple fair at night with colorful lights and stalls, festive',
    'Mid-Autumn Festival mooncakes with lanterns, warm golden glow',
    'festival flowers and silk fabric with golden light, Thai festive decor',
    'a traditional Thai khantoke dinner setting with flowers, cultural',
    'Diwali oil lamps glowing in a colorful pattern, festival of lights',
    'golden marigold garlands for Thai ceremony, auspicious and vibrant',
    'a night market with colorful food stalls and fairy lights, festive',
    'a Visakha Bucha candle procession, glowing in the dark, peaceful',
    'a Songkran water fight scene, splashing fun, colorful',
    'a beautifully lit stage at a cultural festival, dramatic atmosphere',
    'wax drip candles at a Buddhist ceremony, golden and spiritual',
    'a golden floating krathong on dark water, Loy Krathong night',
    'Thai traditional dance performance in full costume, cultural festival',
    'a Makha Bucha candle-lit procession around a white temple, sacred',
    'flower garlands at a Thai wedding ceremony, auspicious, fragrant',
    'Chinese dragon decoration at a festival, red and gold, vibrant',
    'a Halloween friendly pumpkin with autumn leaves, playful, not scary',
    'Mother Day jasmine flowers in blue and white tones, Thai celebration',
    'a red and gold Thai ceremonial decoration, traditional regal',
    'an Asanha Bucha Dhamma wheel with candles, sacred and golden',
    'a beautiful Khanom Chin and Thai festival food on a banana leaf',
    'Valentine Day roses and hearts, festive romantic celebration',
  ],
  family: [
    'a warm family silhouette at sunset on a hilltop, togetherness, golden light',
    'a cozy family breakfast at a sunny table, happiness and togetherness',
    'grandparents and grandchildren playing together in a garden, joy',
    'a mother and child looking at stars, tender moment, night sky',
    'a family picnic in a park with flowers, joy and connection',
    'a parent reading a book to a child by a window, heartwarming',
    'a family cooking together in a warm kitchen, togetherness',
    'hands of three generations stacked together, family love, macro',
    'a family planting flowers in a garden, care and nurturing',
    'silhouettes of a family flying kites at sunset, carefree and happy',
    'a warm family dinner table with candles and flowers, celebration',
    'a father carrying child on his shoulders at the beach, joy',
    'grandmother teaching grandchild to bake, knowledge and love',
    'a family looking at photo albums together, nostalgia and warmth',
    'a couple holding a newborn baby wrapped in white, new life, tender',
    'children playing in fallen autumn leaves with parents, seasonal joy',
    'a family home exterior with flowers and warm window light, comfort',
    'children running toward parents in a sunny meadow, love and reunion',
    'siblings holding hands walking down a path, bond and solidarity',
    'a family watching a sunrise from a porch, contemplation together',
    'family cultural event in Thai traditional ceremony, respect and unity',
    'parents and adult children reunion at a family home, homecoming',
    'a Thai family offering food to monks at dawn, merit making, cultural',
    'a big extended family gathering under a large tree, community',
    'a mother and daughter picking flowers in a garden, warm bond',
    'a grandfather teaching grandchild fishing by a river, patience',
    'family faces around a birthday cake with candles, celebration',
    'a family morning yoga session on a porch, healthy lifestyle together',
    'a family crafting together, creativity and togetherness',
    'a family watching sunset from a hilltop, peace and belonging',
  ],
  pets: [
    'an adorable fluffy cat napping in morning sunlight, cozy and peaceful',
    'a golden retriever puppy playing in a flower field, joyful and cute',
    'a tiny kitten with big blue eyes peeking out of a basket, kawaii',
    'a cat sitting on a window sill watching rain, cozy and contemplative',
    'a bunny rabbit nibbling on a carrot in a garden, cute and charming',
    'a dog and cat sleeping together, friendship, warm and fuzzy',
    'a colorful parrot on a branch in morning light, vibrant and cheerful',
    'a hamster holding a tiny flower, close-up, adorable kawaii style',
    'a golden fortune cat statue with coins, Thai auspicious, shiny',
    'a pair of goldfish in a clear bowl with water plants, serene and colorful',
    'a Shiba Inu puppy sitting in autumn leaves, photogenic and cute',
    'a puppy wearing a flower crown, cute portrait, soft pastel background',
    'a lazy cat stretching in a sunbeam, contentment, photographic',
    'baby turtles on a sandy beach at sunrise, new life and hope',
    'a white fluffy cat in a flower garden, dreamy and beautiful',
    'a dog looking out a car window, adventure and joy, motion blur',
    'baby ducks following their mother by a pond, family and nature',
    'a colorful betta fish in clear water with bubbles, vibrant and graceful',
    'a sleepy puppy in a soft blanket nest, warm and cozy, close-up',
    'a playful kitten chasing a butterfly, youth and wonder',
    'a tiny dog on a big fluffy bed, contrast and cuteness',
    'a cat resting on a Thai temple step, cultural and serene',
    'a parrot eating fresh fruit, colorful and lively, tropical',
    'a dog in a sunflower field, joy and nature, vibrant colors',
    'a sleeping kitten with one paw on a book, adorable',
    'a rabbit in a field of clover, pastoral and sweet',
    'pet pawprint in clay with a flower, memory and love',
    'a silhouette of a dog running on a beach at sunset, freedom and joy',
    'a cat and dog touching noses, inter-species friendship, cute',
    'a fluffy white cat surrounded by pink flower petals, dreamy',
  ],
  coffee: [
    'a cozy cup of coffee on a window sill with morning mist outside, peaceful',
    'beautiful latte art in a ceramic cup, warm morning light, close-up',
    'coffee beans spilling from a burlap sack on wood, rustic and aromatic',
    'a flat white in a minimalist cup with saucer, clean aesthetic',
    'a glass of iced coffee with milk swirling, refreshing summer morning',
    'coffee and a croissant on a marble table, Parisian cafe morning',
    'a Thai iced coffee in a plastic bag with condensation, street food authentic',
    'steam rising from a hot espresso in the morning light, aromatic',
    'a pour-over coffee setup with goose-neck kettle, artisan brewing',
    'coffee and cinnamon sticks with autumn leaves, cozy fall morning',
    'a cafe window with rain outside and a warm latte inside, cozy mood',
    'a breakfast spread with coffee, eggs, and flowers, morning joy',
    'Vietnamese egg coffee in a glass, golden and creamy',
    'a cold brew coffee with ice cubes in a mason jar, summer vibes',
    'coffee and a book on a cozy blanket, perfect morning',
    'a vintage coffee grinder with beans, rustic and nostalgic',
    'two mugs of hot coffee side by side on a wooden table, companionship',
    'coffee foam art a heart in a flat white, barista craft',
    'a Korean dalgona whipped coffee, photogenic and trending',
    'a coffee plantation at sunrise, rows of coffee trees, peaceful',
    'a barista hands carefully pouring steamed milk, craft and care',
    'coffee and flowers in the same frame, morning beauty, flat lay',
    'a spiced chai tea with star anise and cinnamon, aromatic morning',
    'a rooftop cafe at sunrise with a coffee cup, urban and dreamy',
    'a cozy coffee corner with soft fairy lights, warm atmosphere',
    'traditional Thai drip coffee with cloth bag filter, heritage drink',
    'an overhead shot of a coffee cup and flower arrangements, flat lay',
    'moka pot on a gas stove with morning light, Italian-style coffee',
    'a retro cafe interior with plants and warm light, vintage cozy atmosphere',
    'Vietnamese ca phe sua da and tropical fruits, cafe culture',
  ],
  nature: [
    'a majestic sunrise over rolling mountain ranges, layers of mist, golden',
    'a waterfall cascading into a crystal clear pool in a tropical forest',
    'a crystal clear mountain lake reflecting surrounding peaks, mirror image',
    'morning mist floating through a bamboo forest, zen and ethereal',
    'a red-orange canyon at golden hour, dramatic geological landscape',
    'stars and milky way over a dark mountain landscape, universe wonder',
    'a tropical beach with turquoise water and white sand at sunrise',
    'autumn maple leaves in vibrant red and orange, seasonal beauty',
    'a rice terrace landscape in Thailand at dawn, misty green valleys',
    'a vast sunflower field under a blue sky, joyful nature',
    'sea of clouds from a mountain summit, aerial dreamlike view',
    'a tropical rainforest with shafts of light, lush and green',
    'a peaceful river with smooth stones and clear water, flowing life',
    'a dramatic cliff above the ocean at sunset, power and beauty',
    'spring flowers blooming in a meadow, wildflower diversity',
    'a deep blue ocean horizon at sunrise, vastness and calm',
    'cherry blossom petals falling on a still garden pond, Japan spring',
    'a coastal village at sunrise with fishing boats, tranquil morning',
    'golden wheat fields with red poppies, summer landscape',
    'a panorama of a Thai national park with karst limestone peaks',
    'fog-filled valley viewed from a mountaintop, mysterious morning',
    'a rainforest waterfall with rainbow in the mist, magical atmosphere',
    'a blooming sakura tunnel, pink archway, spring delight',
    'wooden bridge over a lotus pond at sunrise, tranquil Thai countryside',
    'aerial view of green tea terraces at sunrise, mist in valleys, serene',
    'a calm beach at low tide with starfish and shells, peaceful',
    'mangrove roots in clear shallow water, coastal nature',
    'northern Thailand mountains and mist at golden hour, stunning landscape',
    'a firefly-lit forest at night, magical glowing insects, enchanted',
    'a frost-covered meadow at dawn, delicate and ethereal light',
  ],
};

// ── ระบุหมวดหมู่ของรูปแต่ละใบจาก subject/prompt ──────────────────────
function guessCategory(subject, src) {
  const p = (subject || '').toLowerCase();
  const pName = src ? (src.name || '').toLowerCase() : '';
  const txt = p + ' ' + pName;

  if (/flower|rose|lotus.*flower|orchid|dahlia|lily|blossom|bloom|bouquet|petal|tulip|lavender|frangipani|hydrangea|sunflower|jasmine.*flower|marigold/.test(txt)) return 'flowers';
  if (/buddha|temple|pagoda|stupa|monk|dharma|prayer|sacred|shrine|altar|incense|merit|alms|buddhist/.test(txt)) return 'dharma';
  if (/lighthouse|sprout.*soil|eagle.*soar|rainbow.*hope|hot.*air.*balloon|footprint.*sand|candle.*darkness|resilience|overcome|new.*beginning.*sunrise|inspiration/.test(txt)) return 'inspire';
  if (/heart.*rose|love.*letter|missing|longing|romance|two.*chair|two.*mug|two.*tree|message.*bottle|anniversary|two sparrows/.test(txt)) return 'miss';
  if (/birthday|cake.*candle|balloon.*party|confetti|cupcake.*sprinkle|gift.*wrap|birthday.*cake/.test(txt)) return 'birthday';
  if (/elderly|grandparent|grandchild|silver.*hair|older.*couple|tai.*chi|senior|elder/.test(txt)) return 'elderly';
  if (/yoga|breakfast.*bowl.*fruit|smoothie|stethoscope|fitness|herbal.*tea|wellness|medicine|doctor|health|stretching/.test(txt)) return 'health';
  if (/songkran|loy.*krathong|krathong|festival|firework|new year.*celeb|christmas tree|diwali|makha|visakha|asalha|cultural.*festival|temple.*fair/.test(txt)) return 'festival';
  if (/family.*silhouette|family.*together|family.*dinner|three.*generation|father.*child|mother.*child|grandchild|sibling|family.*picnic/.test(txt)) return 'family';
  if (/kitten|puppy|dog|cat|hamster|pet|bunny|rabbit|parrot|fish.*bowl|betta|turtle.*beach|golden.*retriever|shiba|corgi/.test(txt)) return 'pets';
  if (/coffee|latte|espresso|cafe|cappuccino|drip.*coffee|cold brew|barista|mug.*cozy/.test(txt)) return 'coffee';
  if (/mountain.*mist|waterfall|ocean.*horizon|canyon|aurora|rice.*terrace|mangrove|beach.*sunrise|bamboo.*forest|cherry.*blossom.*pond|sea.*cloud/.test(txt)) return 'nature';
  // fallback ตาม SUBJECTS เดิม
  if (/lotus|flower|bloom|ดอก/.test(txt)) return 'flowers';
  if (/mountain|landscape|forest|nature|sunrise.*sea|sunset.*cliff/.test(txt)) return 'nature';
  return null;
}

// สร้าง categories map จาก images array
function buildCategoryMap(images) {
  const map = {};
  for (const img of images) {
    const cat = img.category;
    if (!cat) continue;
    if (!map[cat]) map[cat] = [];
    map[cat].push({ file: img.file, blessing: img.blessing || '', src: img.src || null, headline: img.headline || '' });
  }
  return map;
}


// ── CAT_BLESSINGS — คำอวยพรแยกตามหมวด ─────────────────────────────────
const CAT_BLESSINGS = {
  flowers: [
    'ขอให้ชีวิตสดใสงดงามดั่งดอกไม้ที่บาน',
    'ดอกไม้บานฉันใด ขอให้ชีวิตเบ่งบานฉันนั้น',
    'ส่งดอกไม้แห่งความรักและความสุขให้คุณ',
    'ขอให้วันนี้สดชื่นหอมหวานดั่งดอกไม้ยามเช้า',
    'ดอกไม้ทุกดอกมีความงาม เหมือนคุณที่มีคุณค่าในใจฉัน',
    'ขอให้ความสุขเบ่งบานในชีวิตทุกวัน',
    'ส่งความรักผ่านดอกไม้ ขอให้มีแต่สิ่งดีๆ',
    'ดอกไม้หอมชื่นใจ ขอให้คุณสดชื่นอยู่เสมอ',
  ],
  dharma: [
    'ขอให้ธรรมะนำทางให้ชีวิตสงบสุขร่มเย็น',
    'ทำบุญทำทาน จิตใจย่อมผ่องใสเป็นสุข',
    'บุญที่ทำมาคุ้มครองรักษาทุกย่างก้าว',
    'ขอให้พบแต่สิ่งดีงาม ตามครรลองธรรม',
    'ธรรมะคือเกราะป้องกันภัย ขอให้ปลอดภัยทุกวัน',
    'ใจสงบ ชีวิตสุข ขอให้จิตใจร่มเย็น',
    'บุญกุศลที่สั่งสมมาคุ้มครองให้ชีวิตดีงาม',
    'ขอให้มีสติปัญญา เมตตา กรุณา เป็นเครื่องนำทาง',
    'ทำดีได้ดี ขอให้ผลบุญส่งให้ชีวิตสุขสมหวัง',
    'ขอให้จิตใจผ่องใส ห่างไกลทุกข์โศก',
  ],
  inspire: [
    'วันใหม่ โอกาสใหม่ ขอให้ก้าวไปข้างหน้าอย่างมั่นใจ',
    'ขอให้มีกำลังใจสู้ต่อ ทุกปัญหาผ่านไปได้แน่นอน',
    'คุณทำได้ ขอเป็นกำลังใจให้ตลอดไป',
    'ความพยายามไม่เคยทำให้ใครผิดหวัง',
    'ขอให้ทุกความฝันกลายเป็นความจริง',
    'อย่าท้อ เพราะรุ้งงามเสมอหลังสายฝน',
    'ขอให้วันนี้เป็นวันที่ดีที่สุดในชีวิต',
    'กำลังใจจากฉัน ส่งให้คุณทุกวัน',
    'เชื่อมั่นในตัวเอง คุณมีคุณค่ามากกว่าที่คิด',
    'ขอให้พลังและความกล้าอยู่เคียงข้างตลอดไป',
  ],
  miss: [
    'คิดถึงเสมอ ไม่ว่าจะอยู่ที่ไหน',
    'ระยะทางไม่อาจขวางกั้นความห่วงใย',
    'ส่งความคิดถึงให้ถึงมือคุณทุกวัน',
    'อยู่ห่างกันแต่ใจไม่เคยห่าง',
    'ขอให้รู้ว่าฉันนึกถึงคุณเสมอ',
    'ความรักและความคิดถึง ส่งให้ถึงคุณทุกเวลา',
    'แม้ไกลแค่ไหน ก็ยังระลึกถึงกันเสมอ',
    'ขอให้คุณอบอุ่นใจรู้ว่ามีคนคิดถึง',
  ],
  birthday: [
    'สุขสันต์วันเกิด ขอให้มีความสุขมากๆ นะคะ',
    'วันนี้วันพิเศษของคุณ ขอให้ทุกความปรารถนาสมหวัง',
    'ขอให้มีอายุยืนยาว สุขภาพแข็งแรง',
    'Happy Birthday! ขอให้ทุกวันเป็นวันที่ดีที่สุด',
    'วันเกิดปีนี้ ขอให้มีแต่ความสุขและรอยยิ้ม',
    'ขอให้พรวันเกิดทุกข้อเป็นจริง',
    'อีกหนึ่งปีที่ผ่านมา ขอให้ปีนี้ดีกว่าเดิม',
    'วันเกิดของคุณคือวันที่โลกได้คนดีเพิ่มขึ้นหนึ่งคน',
    'ขอให้เค้กอร่อย ปาร์ตี้สนุก และชีวิตสดใส',
    'ส่งความรักและคำอวยพรในวันพิเศษของคุณ',
  ],
  elderly: [
    'ขอให้สุขภาพแข็งแรง อายุยืนยาว มีความสุขทุกวัน',
    'ความห่วงใยจากลูกหลาน ส่งให้ถึงมือท่านทุกวัน',
    'ขอให้ท่านมีแต่ความสุข สบายกาย สบายใจ',
    'ผู้ใหญ่ที่เคารพรัก ขอให้ท่านโชคดีมีสุขนะคะ',
    'ขอให้ท่านแข็งแรงสมบูรณ์ ไม่มีโรคภัยรบกวน',
    'ความรักและกตัญญูจากลูกหลาน ฝากถึงท่านเสมอ',
    'ขออวยพรให้ท่านมีอายุวัฒนะ พลานามัยสมบูรณ์',
    'วันนี้ขอให้ท่านพักผ่อนให้สบาย และมีความสุขนะคะ',
  ],
  health: [
    'ขอให้สุขภาพแข็งแรง ห่างไกลโรคภัยทุกอย่าง',
    'ดูแลสุขภาพด้วยนะคะ เพราะคุณสำคัญมาก',
    'กินอาหารดี นอนหลับพักผ่อนดี ใจก็ดีตามมา',
    'ขอให้ร่างกายแข็งแรง จิตใจสดชื่นทุกวัน',
    'สุขภาพดีคือสมบัติที่ดีที่สุด ขอให้มีไว้ตลอดไป',
    'ขอให้พลังงานเต็มเปี่ยม พร้อมทำทุกอย่างที่ต้องการ',
    'ดูแลตัวเองด้วยนะคะ เพราะทุกคนรักและห่วงใยคุณ',
    'ขอให้หายจากความเจ็บป่วยไวๆ และกลับมาแข็งแรง',
    'สุขภาพกายดี สุขภาพใจดี ชีวิตก็ดีตามมา',
    'ขอให้มีพลังกายพลังใจที่แข็งแกร่งทุกวัน',
  ],
  festival: [
    'ขอให้เทศกาลนี้เต็มไปด้วยความสุขและรอยยิ้ม',
    'ฉลองด้วยกัน ขอให้ความสุขอยู่เต็มหัวใจ',
    'เทศกาลแห่งความสุข ขอให้ได้รับสิ่งที่ดีที่สุด',
    'ขอให้เทศกาลครั้งนี้สนุกสนานและประทับใจตลอดไป',
    'ความสุขในเทศกาล ขอให้อยู่กับคุณทุกวัน',
    'ขอให้วันเทศกาลนี้มีแต่ความสว่างสดใส',
    'รื่นเริงในเทศกาล ขอให้ความสุขไม่มีวันหมด',
    'ขอให้เทศกาลนี้นำพาสิ่งดีๆ มาสู่ชีวิต',
  ],
  family: [
    'ครอบครัวคืออบอุ่น ขอให้ทุกคนในบ้านสุขสบาย',
    'รักครอบครัวเสมอ ขอให้ทุกคนมีแต่ความสุข',
    'ขอให้ครอบครัวอยู่พร้อมหน้ากัน สุขสันต์ตลอดไป',
    'ความรักในครอบครัวคือพลังที่แข็งแกร่งที่สุด',
    'ขอให้บ้านเต็มไปด้วยเสียงหัวเราะและความสุข',
    'ครอบครัวที่รักกัน คือสมบัติล้ำค่าที่สุดในโลก',
    'ขอให้ทุกคนในครอบครัวแข็งแรงและมีความสุข',
    'วันนี้คิดถึงครอบครัว ขอส่งความรักถึงทุกคน',
    'ขอให้รอยยิ้มของครอบครัวสว่างบ้านทุกวัน',
  ],
  pets: [
    'รักน้องหมาน้องแมว ขอให้สุขภาพแข็งแรงทั้งคนและสัตว์',
    'น้องขน ๆ ทำให้วันนี้อบอุ่นขึ้นมากเลย',
    'ขอให้น้องสัตว์เลี้ยงสุขภาพดี น่ารัก และมีความสุข',
    'ความรักจากน้องสี่ขา ทำให้ชีวิตอบอุ่นและมีความหมาย',
    'ขอให้วันนี้สนุกสนานกับเพื่อนขนฟูของคุณ',
    'น้องสัตว์เลี้ยงคือยาวิเศษ ขอให้อยู่เคียงข้างนานๆ',
    'ขอให้คุณและน้องมีความสุขด้วยกันทุกวัน',
    'เลี้ยงสัตว์คือให้ความรัก ขอให้ความรักนั้นส่งกลับมา',
  ],
  coffee: [
    'เช้านี้ขอให้กาแฟอร่อย วันนี้ขอให้ราบรื่น',
    'กาแฟร้อนๆ ยามเช้า เติมพลังให้วันดีๆ',
    'ขอให้เช้าวันนี้สดชื่น เหมือนกาแฟหอมๆ',
    'ชีวิตดีเริ่มต้นด้วยกาแฟดีๆ และคนดีๆ รอบข้าง',
    'เช้าวันใหม่ กาแฟใหม่ ความสุขใหม่',
    'ขอให้วันนี้สดใสตั้งแต่ต้น เหมือนกาแฟยามเช้า',
    'กาแฟหนึ่งแก้ว เติมรอยยิ้มให้วันได้เลย',
    'ขอให้วันนี้ไหลลื่นสบายๆ เหมือนดื่มกาแฟอุ่นๆ',
    'เช้าที่ดีต้องมีกาแฟ และคนที่รักรอบข้าง',
  ],
  nature: [
    'ธรรมชาติงดงาม ขอให้ชีวิตงดงามเช่นนั้น',
    'วิวสวยยามเช้า เหมือนวันใหม่ที่เต็มไปด้วยความหวัง',
    'ขอให้ชีวิตสดชื่นดั่งธรรมชาติที่บริสุทธิ์',
    'ธรรมชาติสอนเราว่าทุกวันคือวันใหม่ที่สวยงาม',
    'ขอให้จิตใจสงบเย็นดั่งธรรมชาติที่งดงาม',
    'วันนี้ขอให้รับพลังงานดีๆ จากธรรมชาติ',
    'ความงามของธรรมชาติ เตือนใจให้ขอบคุณทุกวัน',
    'ขอให้ชีวิตสดใสเขียวขจีดั่งป่าเขาที่สวยงาม',
    'ธรรมชาติมอบความสงบ ขอให้คุณพบความสงบเช่นนั้น',
  ],
};

// สุ่มคำอวยพรตามหมวด
function pickCatBlessing(catId) {
  const pool = CAT_BLESSINGS[catId];
  if (!pool || !pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── พุทธศาสนสุภาษิต พร้อมคำแปล (สำหรับหมวดธรรมะ + วันพระ) ──────────────
const DHAMMA_PROVERBS = [
  { pali: 'อตฺตา หิ อตฺตโน นาโถ', th: 'ตนแลเป็นที่พึ่งแห่งตน' },
  { pali: 'สพฺเพ ธมฺมา อนตฺตา', th: 'ธรรมทั้งหลายทั้งปวงเป็นอนัตตา' },
  { pali: 'อนิจฺจา วต สงฺขารา', th: 'สังขารทั้งหลายไม่เที่ยงหนอ' },
  { pali: 'นตฺถิ สนฺติปรํ สุขํ', th: 'ความสุขอื่นยิ่งกว่าความสงบไม่มี' },
  { pali: 'สุขา สงฺฆสฺส สามคฺคี', th: 'ความพร้อมเพรียงของหมู่คณะนำมาซึ่งความสุข' },
  { pali: 'เมตฺตา โลกํ รกฺขติ', th: 'เมตตาธรรมค้ำจุนโลก' },
  { pali: 'ขนฺติ ปรมํ ตโป ตีติกฺขา', th: 'ความอดทนคือตบะอย่างยิ่ง' },
  { pali: 'ธมฺโม หเว รกฺขติ ธมฺมจารึ', th: 'ธรรมย่อมรักษาผู้ประพฤติธรรม' },
  { pali: 'ปญฺญา นรานํ รตนํ', th: 'ปัญญาเป็นรัตนะของนรชน' },
  { pali: 'อโรคฺยา ปรมา ลาภา', th: 'ความไม่มีโรคเป็นลาภอันประเสริฐ' },
  { pali: 'สจฺจํ เว อมตา วาจา', th: 'คำสัตย์แลเป็นวาจาไม่ตาย' },
  { pali: 'กลฺยาณมิตฺตตา', th: 'การมีมิตรดี เป็นมงคลของชีวิต' },
  { pali: 'จิตฺเต อสงฺกิลิฏฺเฐ สุคติ ปาฏิกงฺขา', th: 'เมื่อจิตไม่เศร้าหมอง สุคติเป็นที่หวังได้' },
  { pali: 'ทานญฺจ ธมฺมจริยา จ', th: 'การให้ทานและการประพฤติธรรม นำสุขมาให้' },
  { pali: 'สีเลน สุคตึ ยนฺติ', th: 'คนทั้งหลายไปสู่สุคติได้ด้วยศีล' },
];
function pickDhammaProverb() {
  return DHAMMA_PROVERBS[Math.floor(Math.random() * DHAMMA_PROVERBS.length)];
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
  okpansa: { color:'#C79A3A', c2:'#6e5215', tone:'serene candlelight gold', headline:'วันออกพรรษา', ownBlessings:true,
    subjects:['lanterns and floating lights at night near a serene Thai temple, peaceful, no people, no text','a row of golden Buddhist monk alms bowls with flowers and candles, end of lent offering, tranquil temple, no text','glowing candlelight offerings on a lotus leaf at a temple pond at night, tranquil, respectful, no text','Thai temple with thousand candles at dusk for ok phansa ceremony, golden glow, peaceful, no people, no text'],
    blessings:['วันออกพรรษา ขอให้จิตใจผ่องใส เปี่ยมด้วยบุญกุศล','ออกพรรษาแล้ว ขอให้ชีวิตสว่างใสดั่งประทีป','ขอบุญกุศลที่ทำในพรรษาหนุนนำให้ชีวิตร่มเย็น'] },
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
  '2026-10-28': FX.okpansa,      // ออกพรรษา
  '2026-09-25': FX.midautumn,    // ไหว้พระจันทร์
  '2026-11-25': FX.loykrathong,  // ลอยกระทง
  // ปีถัดไปเติมที่นี่
};
function getFestival(iso) {
  const mmdd = iso.slice(5);
  return FX_DATED[iso] || FX_FIXED[mmdd] || null;
}

// ── วันพระ: ใช้ตารางจริงทั้งปี (แม่นยำ 100% รวมปีอธิกมาส) ──────────────
// ที่มา: myhora.com / กรมการศาสนา — ปี 2569 เป็นปีอธิกมาส (เดือน 8 สองหน)
// วันสำคัญทางพุทธเลื่อน 1 เดือน สูตรคำนวณ lunar phase ธรรมดาจึงพลาด ต้องใช้ตาราง
const WAN_PHRA_DATES = new Set([
  '2026-01-03','2026-01-11','2026-01-18','2026-01-26','2026-02-02','2026-02-10',
  '2026-02-16','2026-02-24','2026-03-03','2026-03-11','2026-03-18','2026-03-26',
  '2026-04-02','2026-04-10','2026-04-16','2026-04-24','2026-05-01','2026-05-09',
  '2026-05-16','2026-05-24','2026-05-31','2026-06-08','2026-06-14','2026-06-22',
  '2026-06-29','2026-07-07','2026-07-14','2026-07-22','2026-07-29','2026-07-30',
  '2026-08-06','2026-08-13','2026-08-21','2026-08-28','2026-09-05','2026-09-11',
  '2026-09-19','2026-09-26','2026-10-04','2026-10-11','2026-10-19','2026-10-26',
  '2026-11-03','2026-11-09','2026-11-17','2026-11-24','2026-12-02','2026-12-09',
  '2026-12-17','2026-12-24',
]);
const WAN_PHRA_LUNAR = {
  '2026-06-08':'แรม ๘ ค่ำ เดือน ๗','2026-06-14':'แรม ๑๔ ค่ำ เดือน ๗',
  '2026-06-22':'ขึ้น ๘ ค่ำ เดือน ๘','2026-06-29':'ขึ้น ๑๕ ค่ำ เดือน ๘',
  '2026-07-07':'แรม ๘ ค่ำ เดือน ๘','2026-07-14':'แรม ๑๕ ค่ำ เดือน ๘',
  '2026-07-22':'ขึ้น ๘ ค่ำ เดือน ๘๘','2026-07-29':'ขึ้น ๑๕ ค่ำ เดือน ๘๘',
  '2026-07-30':'แรม ๑ ค่ำ เดือน ๘๘','2026-08-06':'แรม ๘ ค่ำ เดือน ๘๘',
  '2026-08-13':'แรม ๑๕ ค่ำ เดือน ๘๘','2026-08-21':'ขึ้น ๘ ค่ำ เดือน ๙',
  '2026-08-28':'ขึ้น ๑๕ ค่ำ เดือน ๙','2026-09-05':'แรม ๘ ค่ำ เดือน ๙',
  '2026-09-11':'แรม ๑๔ ค่ำ เดือน ๙','2026-09-19':'ขึ้น ๘ ค่ำ เดือน ๑๐',
  '2026-09-26':'ขึ้น ๑๕ ค่ำ เดือน ๑๐','2026-10-04':'แรม ๘ ค่ำ เดือน ๑๐',
  '2026-10-11':'แรม ๑๕ ค่ำ เดือน ๑๐','2026-10-19':'ขึ้น ๘ ค่ำ เดือน ๑๑',
  '2026-10-26':'ขึ้น ๑๕ ค่ำ เดือน ๑๑','2026-11-03':'แรม ๘ ค่ำ เดือน ๑๑',
  '2026-11-09':'แรม ๑๔ ค่ำ เดือน ๑๑','2026-11-17':'ขึ้น ๘ ค่ำ เดือน ๑๒',
  '2026-11-24':'ขึ้น ๑๕ ค่ำ เดือน ๑๒','2026-12-02':'แรม ๘ ค่ำ เดือน ๑๒',
  '2026-12-09':'แรม ๑๕ ค่ำ เดือน ๑๒','2026-12-17':'ขึ้น ๘ ค่ำ เดือน ๑',
  '2026-12-24':'ขึ้น ๑๕ ค่ำ เดือน ๑',
};
// fallback คำนวณจาก lunar phase (สำหรับวันที่ไม่อยู่ในตาราง เช่น ปี 2570+)
function isWanPhraCalc(dateObj) {
  const synodic = 29.53058867;
  const knownNewMoon = 2451550.1;
  const jd = Math.floor(dateObj.getTime() / 86400000) + 2440587.5 + 0.5;
  const daysSince = jd - knownNewMoon;
  let phase = ((daysSince % synodic) + synodic) % synodic;
  const PHASES = [0.0, 7.38, 14.77, 22.15];
  const tol = 0.55;
  return PHASES.some(p => { const d = Math.abs(phase - p); return d < tol || Math.abs(d - synodic) < tol; });
}
function isWanPhra(dateObj) {
  const iso = isoDate(dateObj);
  // ถ้าอยู่ในตารางจริง (ปีที่มีข้อมูล) ใช้ตาราง
  if (iso.startsWith('2026-')) return WAN_PHRA_DATES.has(iso);
  // ปีอื่น: fallback คำนวณ (อาจคลาดเคลื่อน ±1 วันในปีอธิกมาส)
  return isWanPhraCalc(dateObj);
}

// ตรวจวันพระพิเศษ (วันพระใหญ่ที่เป็นวันสำคัญทางพุทธศาสนา)
const WAN_PHRA_SPECIAL_DATES = {
  // วันมาฆบูชา วันวิสาขบูชา วันอาสาฬหบูชา เข้า/ออกพรรษา อยู่ใน FX_DATED แล้ว
  // ใส่เฉพาะที่ไม่ได้อยู่ใน FX
};
function checkWanPhraSpecial(iso) {
  return WAN_PHRA_SPECIAL_DATES[iso] || null;
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
  // วัด 2 ค่าต่อแถบ: detail (gradient) + ความสว่างเฉลี่ย
  // subject เด่น (หน้าคน/พระทอง) มักมี detail สูง และ/หรือ สว่างกว่าพื้นหลังมาก → เลี่ยงแถบนั้น
  const measure = (y0, y1) => {
    let n = 0, g = 0, sum = 0;
    for (let y = y0; y < y1 - step; y += step) for (let x = 0; x < W - step; x += step) {
      const i = (y*W+x)*4, j = (y*W+x+step)*4, k = ((y+step)*W+x)*4;
      const l  = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
      const lx = 0.299*data[j]+0.587*data[j+1]+0.114*data[j+2];
      const ly = 0.299*data[k]+0.587*data[k+1]+0.114*data[k+2];
      g += Math.abs(l-lx) + Math.abs(l-ly); sum += l; n++;
    }
    return n ? { detail: g/n, lum: sum/n } : null;
  };
  // แบ่ง 3 แถบ: บน 0-30%, ล่าง 70-100%, และโซนกลาง 30-70% (ที่อยู่ subject) ไว้เทียบ
  const topEnd = Math.floor(H * 0.30), botStart = Math.floor(H * 0.70);
  const midA = Math.floor(H * 0.32), midB = Math.floor(H * 0.68);
  const t = measure(0, topEnd), b = measure(botStart, H), mid = measure(midA, midB);
  if (!t || !b) return null;
  // คะแนน "ความเหมาะวางข้อความ" = detail ต่ำ + ไม่สว่างกว่าโซนกลางมาก (กันทับ subject สว่าง)
  // ยิ่งคะแนนต่ำ = ยิ่งเหมาะ
  const midLum = mid ? mid.lum : (t.lum + b.lum) / 2;
  const scoreOf = (z) => {
    let s = z.detail;
    // ถ้าแถบนี้สว่างใกล้เคียงโซนกลาง (= subject อาจกินมาถึง) เพิ่มโทษ
    if (Math.abs(z.lum - midLum) < 18) s += 14;
    return s;
  };
  const st = scoreOf(t), sb = scoreOf(b);
  return (st < sb / 1.06) ? 'top' : 'bottom';   // เอียงไป bottom เล็กน้อยเมื่อใกล้กัน (ตำแหน่งทักทายดั้งเดิม)
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

async function genBlessingsGemini({ dayTh, headline, isFestival, n, extraContext }) {
  const context = isFestival
    ? `วันนี้เป็น "${headline}"`
    : `วันนี้เป็นวัน${dayTh}`;

  const prompt =
    `คุณเป็นนักเขียนคำอวยพรภาษาไทยที่เข้าใจจิตใจคนไทยดี\n`
  + `${context}\n${extraContext ? extraContext + '\n' : ''}\n`
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

// ── เรียก LLM (chain เดียวกับคำอวยพร) คืน "ข้อความดิบ" — ใช้ซ้ำได้หลายงาน ──
async function llmText(prompt) {
  if (GEMINI_API_KEY) {
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      try {
        const res = await fetchT(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) },
          TXT_TIMEOUT_MS);
        if (!res.ok) throw new Error('http ' + res.status);
        const data = await res.json();
        const t = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (t.trim()) return t;
      } catch (e) { console.log(`llmText ${model}: ${e.message}`); }
    }
  }
  if (GROQ_API_KEY) {
    try {
      const res = await fetchT('https://api.groq.com/openai/v1/chat/completions',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.9 }) },
        60000);
      if (res.ok) { const d = await res.json(); const t = d?.choices?.[0]?.message?.content || ''; if (t.trim()) return t; }
    } catch (e) { console.log('llmText groq:', e.message); }
  }
  if (OPENROUTER_API_KEY) {
    try {
      const res = await fetchT('https://openrouter.ai/api/v1/chat/completions',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
          body: JSON.stringify({ model: 'google/gemma-3-27b-it:free', messages: [{ role: 'user', content: prompt }] }) },
        90000);
      if (res.ok) { const d = await res.json(); const t = d?.choices?.[0]?.message?.content || ''; if (t.trim()) return t; }
    } catch (e) { console.log('llmText openrouter:', e.message); }
  }
  try {
    await gate();
    const res = await fetchT('https://text.pollinations.ai/openai',
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: prompt }] }) }, 90000);
    if (res.ok) { const d = await res.json(); return d?.choices?.[0]?.message?.content || ''; }
  } catch (e) { console.log('llmText pollinations:', e.message); }
  return '';
}

// ── คำขึ้นต้นการ์ด (headline) แยกตามหมวด ────────────────────────────────────
// หมวดที่มี "คำเฉพาะ" ของตัวเอง จะไม่ใช้ "สวัสดีวัน..." ของวัน แต่ขึ้นคำของหมวดก่อน
// (เช่น วันเกิด → "สุขสันต์วันเกิด", คิดถึง → "คิดถึงนะ") — AI คิดใหม่ทุกวัน, มี fallback สำรอง
const CAT_GREETING_FALLBACK = {
  birthday: ['สุขสันต์วันเกิด', 'สุขสันต์วันเกิดนะ', 'สุขสันต์วันเกิดค่ะ', 'Happy Birthday', 'สุขสันต์วันเกิดจ้า'],
  miss:     ['คิดถึงนะ', 'คิดถึงเสมอ', 'คิดถึงจังเลย', 'คิดถึงกันบ้างนะ', 'คิดถึงนะคนดี'],
  inspire:  ['เป็นกำลังใจให้นะ', 'สู้ๆ นะ', 'ส่งกำลังใจให้', 'ขอให้มีกำลังใจ', 'เธอทำได้แน่นอน'],
  health:   ['รักษาสุขภาพนะ', 'สุขภาพแข็งแรงนะ', 'ดูแลสุขภาพด้วยนะ', 'ขอให้สุขภาพดี', 'หายไวๆ นะ'],
  elderly:  ['สุขภาพแข็งแรงนะคะ', 'ขอให้สุขกายสบายใจ', 'รักและห่วงใยเสมอ', 'ขอให้อายุยืนยาว', 'คิดถึงและห่วงใย'],
};
const CAT_GREETING_CATS = Object.keys(CAT_GREETING_FALLBACK);

// AI แต่งคำขึ้นต้นของแต่ละหมวด (คืน object: { birthday:[...], miss:[...], ... })
async function genCatHeadlines() {
  const out = {};
  for (const c of CAT_GREETING_CATS) out[c] = [...CAT_GREETING_FALLBACK[c]];
  const labelTh = { birthday: 'อวยพรวันเกิด', miss: 'คิดถึง/ห่างไกล', inspire: 'ให้กำลังใจ', health: 'ดูแลสุขภาพ', elderly: 'ทักทายผู้สูงวัย' };
  const prompt =
      `คุณเป็นนักเขียนคำทักทายภาษาไทยที่อบอุ่นและเข้าใจคนไทย\n`
    + `ช่วยแต่ง "คำขึ้นต้นการ์ด" (headline สั้น ๆ) ภาษาไทยสำหรับแต่ละหมวดต่อไปนี้ หมวดละ 5 แบบ:\n`
    + CAT_GREETING_CATS.map(c => `- ${c}: ${labelTh[c]}`).join('\n') + '\n'
    + `กติกา:\n`
    + `- สั้น กระชับ 1-4 คำ เหมาะเป็นหัวการ์ด (เช่น "สุขสันต์วันเกิด", "คิดถึงนะ", "เป็นกำลังใจให้")\n`
    + `- หมวด birthday ต้องสื่อถึง "วันเกิด" เสมอ (เช่น สุขสันต์วันเกิด)\n`
    + `- ห้ามมีอิโมจิ ห้ามมีเลขลำดับ ห้ามยาวเกิน 4 คำ\n`
    + `- ตอบกลับเป็น JSON object เท่านั้น รูปแบบ {"birthday":["..."],"miss":["..."],"inspire":["..."],"health":["..."],"elderly":["..."]} ห้ามมี markdown หรือ backtick`;
  const text = await llmText(prompt).catch(() => '');
  if (text) {
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const obj = JSON.parse(m[0]);
        for (const c of CAT_GREETING_CATS) {
          const arr = Array.isArray(obj[c])
            ? obj[c].filter(x => typeof x === 'string' && x.trim().length > 1 && x.trim().length <= 24).map(x => x.trim())
            : [];
          if (arr.length >= 2) out[c] = arr;
        }
        console.log(`✓ cat headlines: ${CAT_GREETING_CATS.map(c => c + '(' + out[c].length + ')').join(' ')}`);
      }
    } catch (e) { console.log('cat headline parse fail:', e.message); }
  }
  return out;
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
// กันโควตา (เวลา + จำนวน gen) ไว้ให้ cat_bank ทุกรอบ ไม่ต้องรอ deck รายวันเต็มก่อน
// (ก่อนหน้านี้ cat_bank ได้คิวก็ต่อเมื่อ deck วันนี้+พรุ่งนี้เต็ม → ส่วนใหญ่ไม่ได้รันเลย)
const CAT_BANK_RESERVE_GENS = Number(process.env.CAT_BANK_RESERVE_GENS || 60);
const CAT_BANK_RESERVE_MS   = Number(process.env.CAT_BANK_RESERVE_MS   || 18 * 60 * 1000);
const BASE_REUSE_GAP_DAYS = Number(process.env.BASE_REUSE_GAP_DAYS || 21); // base เดิมเว้นกี่วันถึงใช้ซ้ำ
const BASE_MAX_SHARE    = Number(process.env.BASE_MAX_SHARE    || (1 / 3)); // สัดส่วน base ต่อวัน
const EVERGREEN_TARGET  = Number(process.env.EVERGREEN_TARGET  || 40);
const PASS_SCORE        = Number(process.env.PASS_SCORE        || 55);  // ผ่านเมื่อคะแนนรวม "เกิน" 55/100 — เพิ่มจาก 50 (มิ.ย.2569: Pollen กลับมา มี 2 AI ตรวจ คัดได้เข้มขึ้น)
const MIN_CLARITY       = Number(process.env.MIN_CLARITY       || 6);   // ความชัดข้อความขั้นต่ำ — เพิ่มจาก 5→6 (มิ.ย.2569: ผู้สูงอายุอ่านยาก ต้องชัดกว่านี้)
const EVERGREEN_DIR     = path.join(IMG_DIR, 'evergreen');

// ── Category Bank — เก็บรูปสำเร็จแยกหมวด (gen ครั้งเดียว เก็บถาวร) ──────
// โฟลเดอร์: img/cat_bank/<catId>/  เช่น img/cat_bank/flowers/
// ไฟล์ index: img/cat_bank/index.json  {catId: {count, target, hashes[], images[]}}
const CAT_BANK_DIR      = path.join(IMG_DIR, 'cat_bank');
const CAT_BANK_TARGET   = Number(process.env.CAT_BANK_TARGET || 30); // รูปต่อหมวด
// หมวดทั้งหมด — ตรงกับ CATEGORIES ใน index.html
const ALL_CATEGORIES    = ['flowers','dharma','inspire','miss','birthday','elderly','health','festival','family','pets','coffee','nature'];

function loadCatBank() {
  const f = path.join(CAT_BANK_DIR, 'index.json');
  if (fs.existsSync(f)) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const cat of ALL_CATEGORIES) {
        if (!d[cat]) d[cat] = { count: 0, images: [], hashes: [] };
      }
      return d;
    } catch (e) {}
  }
  const d = {};
  for (const cat of ALL_CATEGORIES) d[cat] = { count: 0, images: [], hashes: [] };
  return d;
}

function saveCatBank(cb) {
  fs.mkdirSync(CAT_BANK_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAT_BANK_DIR, 'index.json'), JSON.stringify(cb, null, 2));
}

// คืนรายการหมวดที่ยังไม่ครบ เรียงจากน้อยไปมาก (เติมหมวดที่ขาดมากที่สุดก่อน)
function getCatBankDeficit(cb) {
  return ALL_CATEGORIES
    .map(cat => ({ cat, have: cb[cat].count, need: Math.max(0, CAT_BANK_TARGET - cb[cat].count) }))
    .filter(x => x.need > 0)
    .sort((a, b) => a.have - b.have);
}

// ── ล้างการ์ดรายวันที่หลุดเข้าคลังหมวด ────────────────────────────────────────
// คลังหมวด (cat_bank) ต้องเป็นรูป "ไร้วัน" เท่านั้น เพราะหน้าหมวดไม่ได้ผูกกับวันใดวันหนึ่ง
// รูปที่ระบบ gen เองมาจะมี suffix _<n> ต่อท้าย (เช่น cat_flowers_<ts>_<n>.jpg)
// แต่รูปที่เคยถูก copy มาจากการ์ด "วันนี้/พรุ่งนี้" จะเป็น cat_<cat>_<ts>.jpg (ไม่มี suffix)
// ซึ่งมีตัวอักษร "สวัสดีวัน<วัน>" + วันที่ฝังในรูป → ทำให้หน้าหมวดโชว์ "สวัสดีวันพุธ" ทั้งที่วันนี้วันอังคาร
// ฟังก์ชันนี้ตัดรูปเหล่านั้นทิ้ง (และลบ index ที่ซ้ำกัน) ทุกรอบ จึงค่อย ๆ ทำความสะอาดคลังให้เอง
function pruneCopiedDayCards(cb) {
  const COPY_RE = /^cat_[a-z]+_\d+\.jpg$/i; // การ์ดรายวันที่ถูก copy เข้ามา (ไม่มี suffix _<n>)
  let removed = 0;
  for (const cat of ALL_CATEGORIES) {
    const data = cb[cat];
    if (!data || !Array.isArray(data.images)) continue;
    const kept = [], seen = new Set();
    for (const img of data.images) {
      const base = (img && img.file ? img.file : '').split('/').pop();
      if (!base) continue;
      if (COPY_RE.test(base)) {
        try { fs.rmSync(path.join(CAT_BANK_DIR, cat, base), { force: true }); } catch (e) {}
        removed++;
      } else if (!seen.has(base)) {
        seen.add(base); kept.push(img);
      }
    }
    data.images = kept;
    data.count = kept.length;
  }
  if (removed > 0) console.log(`  🧹 cat_bank: ตัดการ์ดรายวันที่หลุดเข้าคลัง ${removed} รูป (คลังหมวดต้องไร้วัน)`);
  return removed;
}



// ── ตัวเรียก vision สำหรับ rubric (คืน "ข้อความดิบ" ให้ lib/rubric parse JSON เอง) ──
// ต่างจาก visionPollinations/visionGemini เดิมที่ parse เป็น OK/BAD — อันนี้ขอ JSON 5 ข้อ
async function visionPollRubric(buf, prompt) {
  const b64 = buf.toString('base64');
  await gate();
  const polHeaders = { 'Content-Type': 'application/json' };
  if (POLLINATIONS_API_KEY) polHeaders.Authorization = `Bearer ${POLLINATIONS_API_KEY}`;
  const res = await fetchT('https://text.pollinations.ai/openai',
    { method: 'POST', headers: polHeaders,
      body: JSON.stringify({ model: 'openai', max_tokens: 200,  // เพิ่มจาก 120 (rubric JSON 5 ข้อ อาจใช้เกิน 120 tokens)
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
    } catch (e) { console.log(`    gemRubric ${model}: ${e.message}`); }
  }
  throw new Error('gemini vision failed (all models exhausted)');
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
  // สร้าง categories map จากรูปที่มี category field
  const categories = buildCategoryMap(images);
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ ...st, images, categories, count: images.length, version: String(Date.now()) }, null, 2));
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

// ── Recent hashes — กันรูปซ้ำข้าม 7 วัน (เก็บ hash อย่างเดียว ไม่เก็บรูป) ──
const RECENT_HASH_FILE = path.join(IMG_DIR, 'recent_hashes.json');
const RECENT_HASH_DAYS = Number(process.env.RECENT_HASH_DAYS || 7);
function loadRecentHashes() {
  if (fs.existsSync(RECENT_HASH_FILE)) {
    try { return JSON.parse(fs.readFileSync(RECENT_HASH_FILE, 'utf8')); } catch (e) {}
  }
  return {}; // { 'YYYY-MM-DD': [hashStr, ...] }
}
function saveRecentHashes(rh, refISO) {
  const pruned = {};
  for (const [iso, hashes] of Object.entries(rh)) {
    if (Math.abs(daysBetween(iso, refISO)) < RECENT_HASH_DAYS) pruned[iso] = hashes;
  }
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.writeFileSync(RECENT_HASH_FILE, JSON.stringify(pruned, null, 2));
}
function recentHashList(rh) { return Object.values(rh).flat(); }

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
  // ── ตรวจวันพระ (ถ้าไม่ใช่วันเทศกาลใหญ่) ──
  const wanPhra = !fest && isWanPhra(tgt);
  const wanPhraSpecial = !fest && checkWanPhraSpecial(targetISO);

  // headline: วันพระ → "วันนี้วันพระ\nสวัสดีวัน..."  (2 บรรทัดตามภาพตัวอย่าง)
  const headline = fest ? fest.headline
    : (wanPhra ? `วันนี้วันพระ สวัสดีวัน${dayTheme.th}` : `สวัสดีวัน${dayTheme.th}`);
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
    wanPhra, wanPhraSpecial: wanPhraSpecial || null,
    lunarDate: WAN_PHRA_LUNAR[targetISO] || null,
  });

  // โหลด hash ย้อนหลัง 7 วัน เพื่อกันภาพซ้ำข้ามสัปดาห์
  const recentHashes = loadRecentHashes();
  const weekHashes = recentHashList(recentHashes);
  if (!recentHashes[targetISO]) recentHashes[targetISO] = [];

  console.log(`=== [rolling] ICT ${liveISO} -> target ${targetISO} (${dayTheme.th})${fest ? ' [เทศกาล]' : ''}${wanPhra ? ' [วันพระ]' : ''}${wanPhraSpecial ? ` [${wanPhraSpecial}]` : ''} | มี ${st.images.length}/${TARGET} ค้างตรวจ ${st.pending.length} ===`);

  // คลังคำอวยพร: gen ครั้งเดียวต่อวัน เก็บใน manifest แล้วใช้ซ้ำข้ามรอบ
  if (fest && fest.ownBlessings && fest.blessings && fest.blessings.length) {
    st.blessings = fest.blessings; // วันสำคัญ/วันรำลึก: ใช้คำของวันนั้นโดยตรง (ไม่ gen โทนรื่นเริง)
    saveManifest(dir, st);
    console.log(`✓ ใช้คำของ ${headline} ${st.blessings.length} คำ`);
  } else if (!st.blessings || st.blessings.length < TARGET) {
    // วันพระ: เพิ่ม context ให้ Gemini gen คำอวยพรที่เกี่ยวกับการทำบุญ
    const wanPhraContext = wanPhra
      ? ' วันนี้เป็น "วันพระ" ซึ่งเป็นวันสำคัญทางพุทธศาสนา ผู้ใช้หลายคนจะไปทำบุญใส่บาตรตอนเช้า ขอให้คำอวยพรส่วนหนึ่ง (ราว 30-40%) สะท้อนถึงการทำบุญ ความเป็นมงคล หรือธรรมะ ใส่ตัวอย่างเช่น "วันพระนี้ ขอให้อิ่มบุญอิ่มใจ" หรือ "ใส่บาตรสร้างบุญวันพระ ขอให้สมหวัง"'
      : '';
    try {
      const bl = await genBlessingsGemini({ dayTh: dayTheme.th, headline, isFestival: !!fest, n: TARGET, extraContext: wanPhraContext });
      if (bl && bl.length) st.blessings = bl;
    } catch (e) { console.log('blessings gen fail:', e.message); }
    if (!st.blessings || !st.blessings.length)
      st.blessings = wanPhra
        ? ['วันพระนี้ ขอให้อิ่มบุญอิ่มใจ','ใส่บาตรวันพระ ขอให้ชีวิตร่มเย็นเป็นสุข','ทำบุญวันพระ ขอให้สมหวังดั่งตั้งใจ','ขอให้เป็นวันที่ดี มีแต่สิ่งมงคล']
        : ['ขอให้เป็นวันที่สดใส', 'ขอให้มีความสุขทุกวัน', 'สุขภาพแข็งแรงนะคะ', 'โชคดีมีสุข สมปรารถนา'];
    // วันพระ: แทรกพุทธศาสนสุภาษิต (คำแปลไทย) เข้าในคลังคำอวยพร ~1 ใน 3
    if (wanPhra) {
      const proverbBlessings = DHAMMA_PROVERBS.map(p => p.th);
      // สลับ: 2 คำอวยพรปกติ + 1 สุภาษิต
      const mixed = [];
      const bl = st.blessings;
      let pi = 0;
      for (let i = 0; i < bl.length; i++) {
        mixed.push(bl[i]);
        if ((i + 1) % 2 === 0 && pi < proverbBlessings.length) {
          mixed.push(proverbBlessings[pi++]);
        }
      }
      // เติมสุภาษิตที่เหลือ
      while (pi < proverbBlessings.length) mixed.push(proverbBlessings[pi++]);
      st.blessings = mixed;
    }
    saveManifest(dir, st);
    console.log(`✓ คำอวยพร ${st.blessings.length} คำ${wanPhra ? ' (วันพระ + พุทธสุภาษิต)' : ''}`);
  }
  const pickBl = (i) => st.blessings[i % st.blessings.length];

  // คำขึ้นต้นแยกหมวด (AI คิดใหม่ทุกวัน) — เก็บใน manifest ใช้ซ้ำข้ามรอบ
  if (!st.catHeadlines || !Object.keys(st.catHeadlines).length) {
    try { st.catHeadlines = await genCatHeadlines(); }
    catch (e) { st.catHeadlines = {}; console.log('cat headlines fail:', e.message); }
    saveManifest(dir, st);
  }
  // คืนคำขึ้นต้นของหมวด (วนตาม index ให้รูปในหมวดเดียวกันไม่ซ้ำคำ) — null = ใช้ "สวัสดีวัน..." ตามปกติ
  const catHeadlineFor = (cat, i) => {
    if (!cat) return null;
    const pool = (st.catHeadlines && st.catHeadlines[cat]) || CAT_GREETING_FALLBACK[cat];
    if (!pool || !pool.length) return null;
    return pool[((i >= 0 ? i : Math.floor(Math.random() * pool.length)) % pool.length)];
  };

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

  // ── voters: AI ที่ใช้ตรวจคุณภาพการ์ด ──────────────────────────────────────
  // Gemini = หลัก (แม่นกว่า, JSON mode บังคับ, ไม่ติด gate delay)
  // Pollinations = เสริม (เร็ว, ติด gate 15.5วิ/call แต่ให้ redundancy)
  // MIN_VOTERS=1 → AI ตัวเดียวพอตัดสิน (กัน pending กอง); =2 → ต้องครบ 2 เสียง
  const voters = [{ name: 'gemini', fn: visionGemRubric }];
  if (USE_POLL_VISION) voters.unshift({ name: 'pollinations', fn: visionPollRubric });
  console.log(`  ✦ voters: ${voters.map(v=>v.name).join('+')} | passScore=${PASS_SCORE} minClarity=${MIN_CLARITY} minVoters=${MIN_VOTERS}`);
  const panel = (cardBuf) => scorePanel(cardBuf, voters, { passScore: PASS_SCORE, minClarity: MIN_CLARITY, minVoters: MIN_VOTERS });

  const renderCard = async ({ raw, blessing, withDay, headlineOverride }) => {
    const band = await bestTextBand(raw);
    // headlineOverride = คำขึ้นต้นเฉพาะหมวด (เช่น "สุขสันต์วันเกิด"); ถ้าไม่ส่งมา ใช้ค่าเริ่มต้นของวัน
    const hl = headlineOverride != null ? headlineOverride : (withDay ? headline : '');
    return renderer.render({
      imgDataUrl: `data:image/jpeg;base64,${raw.toString('base64')}`,
      frameIdx: Math.floor(Math.random() * rCounts.frames),
      layoutIdx: Math.floor(Math.random() * rCounts.layouts),
      txIdx: Math.floor(Math.random() * rCounts.texts),
      ovIdx: Math.floor(Math.random() * rCounts.overlays),
      headline: hl,                                 // evergreen: '' = ไม่ใส่บรรทัด "สวัสดีวัน..."
      blessing, dateThai: withDay ? dateThai : '',
      // คลังหมวด/evergreen (withDay:false) ใช้สีกลาง ไม่ใช้สีประจำวัน เพื่อไม่ให้ดูเหมือนการ์ดของวันใดวันหนึ่ง
      color: (withDay ? theme.color : NEUTRAL_COLOR),
      color2: (withDay ? theme.c2 : NEUTRAL_COLOR2),
      dayTh: withDay ? dayTheme.th : '', size: 800, vp: band || null,
    });
  };

  // harvest: เก็บ "สำเนาไร้วัน" ของรูป deck ที่ผ่าน vision แล้ว ลง cat_bank ตามหมวด
  // ใช้ raw + ผลตรวจ vision ที่จ่ายไปแล้วซ้ำ → ไม่เรียก genImage/vision เพิ่ม แค่ render การ์ดไร้วันอีกใบ
  // (เป็น closure ใน main เพราะต้องใช้ renderCard + catHeadlineFor ที่นิยามในนี้)
  const harvestToCatBank = async (cb, cat, raw, hash, blessing, src) => {
    if (!cat || !cb[cat]) return false;
    if (cb[cat].count >= CAT_BANK_TARGET) return false;
    if (isDuplicate(hash, cb[cat].hashes || [], PHASH_THRESHOLD)) return false;
    const catHl = catHeadlineFor(cat, cb[cat].count);
    let card;
    try { card = await renderCard({ raw, blessing, withDay: false, headlineOverride: catHl || '' }); }
    catch (e) { return false; }
    if (!card || card.length < 2000) return false;
    const catDir = path.join(CAT_BANK_DIR, cat);
    fs.mkdirSync(catDir, { recursive: true });
    // ชื่อมี suffix _h<n> → ไม่เข้า COPY_RE ของ pruneCopiedDayCards จึงไม่ถูกลบ
    const fname = `cat_${cat}_${Date.now()}_h${cb[cat].count}.jpg`;
    fs.writeFileSync(path.join(catDir, fname), card);
    if (!cb[cat].hashes) cb[cat].hashes = [];
    cb[cat].hashes.push(hashToStr(hash));
    cb[cat].images.push({ file: fname, score: 70, blessing, src: src || null, headline: catHl || '' });
    cb[cat].count = cb[cat].images.length;
    saveCatBank(cb);
    console.log(`  ↳ harvest cat_bank[${cat}] +1 (${cb[cat].count}/${CAT_BANK_TARGET})`);
    return true;
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
      const rcat = guessCategory(it.subject || it.file, it.src);
      st.images.push({ file: it.file, score: r.score, blessing: it.blessing, baseId: it.baseId || null, src: it.src || null, category: rcat, subject: it.subject || null, headline: it.headline || headline });
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

  // ถ้า cat_bank ยังขาด ให้ deck รายวัน "ออมโควตา" ไว้ส่วนหนึ่ง (เวลา+จำนวน gen)
  // เพื่อให้ cat_bank ได้คิว gen ทุกรอบ ไม่ใช่เฉพาะรอบที่ deck เต็มแล้ว
  const cb = loadCatBank();
  const catBankNeedsWork = getCatBankDeficit(cb).length > 0;
  const deckStopMs   = catBankNeedsWork ? Math.max(90000, CAT_BANK_RESERVE_MS) : 90000;
  const deckGenCap   = catBankNeedsWork ? Math.max(1, MAX_GEN_PER_RUN - CAT_BANK_RESERVE_GENS) : MAX_GEN_PER_RUN;

  while (st.images.length < TARGET && timeLeft() > deckStopMs && gens < deckGenCap) {
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
          const ph = await fetchStockPhoto(fetchT, TXT_TIMEOUT_MS, dayFlowerQueries(theme.flower, theme.tone));
          raw = ph.buffer; src = ph.src;
          console.log(`[${gens}] photo "${src.name}" by ${src.by} (${st.images.length}/${TARGET})`);
        } catch (e) { console.log('  (photo fail):', e.message); }
      }
      if (!raw) {
        if (fest && Math.random() < FEST_SUBJECT_RATIO) {
          subject = fest.subjects[Math.floor(Math.random() * fest.subjects.length)];
        // วันพระ: เพิ่มสัดส่วนภาพพระพุทธ/วัด/ธรรมะ 50% (ใช้ CATEGORY_SUBJECTS.dharma ที่ curate มาเฉพาะ)
        } else if (wanPhra && Math.random() < 0.50) {
          const dharmaSubs = CATEGORY_SUBJECTS.dharma;
          subject = dharmaSubs[Math.floor(Math.random() * dharmaSubs.length)];
        } else {
          subject = pickSubject(theme);
        }
        if ((st.subjectCount[subject] || 0) >= MAX_SUBJECT_REPEAT) continue;
        do { seed = Math.floor(Math.random() * 1e9); } while (st.usedSeeds.includes(seed));
        const prompt = `${subject}, ${theme.tone} color palette, soft golden morning light, dreamy, elegant, highly detailed, beautiful, no text, no letters, no numbers, no watermark, no signature`;
        console.log(`[${gens}] gen seed=${seed} (${st.images.length}/${TARGET})`);
        raw = await genImage(prompt, seed);
      }
    } catch (e) { console.log('  ! gen:', e.message); continue; }

    // dedup ก่อน composite (ประหยัด) — เช็คทั้งวันนี้ + 7 วันย้อนหลัง
    try { hash = dhash(raw); } catch (e) { continue; }
    if (isDuplicate(hash, st.hashes, PHASH_THRESHOLD) || isDuplicate(hash, weekHashes, PHASH_THRESHOLD)) {
      if (seed != null) st.usedSeeds.push(seed);
      console.log('  ↺ รูปซ้ำ (วันนี้/7วัน) ทิ้ง');
      continue;
    }

    // หมวดของรูปนี้ → เลือกคำขึ้นต้นให้ตรงหมวด (วันเทศกาล/วันพระ คงคำของวันไว้ก่อน)
    const preCat = guessCategory(subject, src);
    const catHl = (fest || wanPhra) ? null : catHeadlineFor(preCat, st.images.length);
    const cardHeadline = catHl || headline;

    // composite = การ์ดสำเร็จ
    let card;
    try { card = await renderCard({ raw, blessing, withDay: true, headlineOverride: catHl || undefined }); }
    catch (e) { console.log('  ! render:', e.message); continue; } // render พัง = ข้ามรูปนี้ (ไม่ fallback รูปดิบ)
    if (!card || card.length < 2000) { console.log('  ! render เล็กผิดปกติ'); continue; }

    const fname = `card_${Date.now()}_${gens}.jpg`;
    fs.writeFileSync(path.join(dir, fname), card);
    const r = await panel(card);

    st.hashes.push(hashToStr(hash));
    recentHashes[targetISO].push(hashToStr(hash));  // เก็บลง 7-day window
    if (seed != null) st.usedSeeds.push(seed);
    if (subject) st.subjectCount[subject] = (st.subjectCount[subject] || 0) + 1;

    if (r.decision === 'keep') {
      const imgCat = guessCategory(subject, src);
      st.images.push({ file: fname, score: r.score, blessing, baseId, src, category: imgCat, subject: subject || null, headline: cardHeadline });
      if (baseId) { baseUsed++; const b = bank.bases.find(x => x.id === baseId); if (b) { b.lastUsed = targetISO; b.uses = (b.uses || 0) + 1; } }
      const scoreBreak = (r.perAI||[]).filter(a=>a.scores).map(a=>`${a.name}:c${a.scores.clarity}b${a.scores.beauty}w${a.scores.warmth}q${a.scores.quality}`).join(' | ');
      console.log(`  ✓ keep ${fname} (${r.score}) [${scoreBreak}]`);
      await harvestToCatBank(cb, imgCat, raw, hash, blessing, src);
    } else if (r.decision === 'pending' && src && PHOTO_TRUST_NOVOTE && (r.perAI||[]).every(a => !a.scores)) {
      // รูปถ่าย royalty-free + AI ล่มหมด → trust (กัน keyword กรองที่ photos.mjs แทน ไม่เพิ่ม Gemini call)
      const ptCat = guessCategory(subject || fname, src);
      st.images.push({ file: fname, score: 60, blessing, baseId, src, category: ptCat, subject: subject || null, headline: cardHeadline });
      console.log(`  ✓ keep(photo-trust) ${fname} [${src.name}] cat=${ptCat||'?'}`);
      await harvestToCatBank(cb, ptCat, raw, hash, blessing, src);
    } else if (r.decision === 'pending') {
      st.pending.push({ file: fname, blessing, baseId, seed, src, tries: 0, headline: cardHeadline });
      console.log(`  … pending ${fname} (${r.reason}) [${(r.perAI||[]).map(a=>`${a.name}:${a.error?('ERR '+a.error):(a.scores?'ok':'no-json')}`).join(' | ')}]`);
    } else {
      fs.rmSync(path.join(dir, fname), { force: true });
      console.log(`  ✗ reject ${fname} (${r.reason}) [${(r.perAI||[]).map(a=>`${a.name}:${a.error?('ERR '+a.error):(a.scores?'ok':'no-json')}`).join(' | ')}]`);
    }
    saveManifest(dir, st);
  }

  saveBank(bank);
  saveManifest(dir, st);

  // 3a) ทำความสะอาดคลังหมวด: ตัดการ์ดรายวันที่เคยถูก copy เข้ามา (มีข้อความ "สวัสดีวัน..." + วันที่ฝังในรูป)
  // เดิมระบบ copy การ์ดของ "วันนี้/พรุ่งนี้" เข้าคลังหมวดเพื่อประหยัด gen แต่การ์ดพวกนี้มีตัวอักษรวัน/วันที่ฝังอยู่
  // ทำให้หน้าหมวดโชว์ "สวัสดีวันพุธ" ทั้งที่วันนี้วันอังคาร — คลังหมวดต้องเติมจากรูปไร้วัน (gen, withDay:false) เท่านั้น
  {
    const cb = loadCatBank();
    if (pruneCopiedDayCards(cb) > 0) saveCatBank(cb);
  }

  // 3) เติม cat_bank + evergreen — cat_bank รันแม้ deck ยังไม่เต็ม (ใช้โควตาที่ออมไว้)
  if (st.images.length >= TARGET || catBankNeedsWork) {
    const cb = loadCatBank();
    const deficit = getCatBankDeficit(cb);
    const NEUTRAL_BLESSINGS = ['สวัสดีค่ะ ขอให้เป็นวันที่ดี', 'ขอให้มีความสุขทุกวัน', 'สุขภาพแข็งแรงนะคะ', 'คิดถึงและห่วงใยเสมอ', 'ขอให้โชคดีมีความสุข',
      'ขอให้ทุกวันพบแต่สิ่งดีๆ', 'รักและห่วงใยเสมอ', 'ขอให้มีกำลังใจ', 'โชคดีมีสุขทุกวัน', 'ขอให้ชีวิตสดใสร่าเริง'];

    // 3a) gen เติม cat_bank หมวดที่ยังขาด (หมวดที่ขาดมากสุดก่อน)
    if (deficit.length > 0) {
      console.log(`  ── cat_bank ขาด ${deficit.length} หมวด: ${deficit.map(d=>d.cat+'('+d.have+'/'+CAT_BANK_TARGET+')').join(', ')}`);
    }
    // วน round-robin ข้ามหมวด (ไม่ gen หมวดเดียวจนหมดก่อน)
    let defIdx = 0;
    while (deficit.length > 0 && timeLeft() > 120000 && gens < MAX_GEN_PER_RUN) {
      // เลือกหมวดถัดไป (round-robin)
      defIdx = defIdx % deficit.length;
      const { cat } = deficit[defIdx];
      if (cb[cat].count >= CAT_BANK_TARGET) { deficit.splice(defIdx, 1); continue; }

      gens++;
      // เลือก subject จาก CATEGORY_SUBJECTS ของหมวดนั้น
      const catSubs = CATEGORY_SUBJECTS[cat] || [];
      const existingFiles = new Set((cb[cat].images || []).map(x => x.file));
      const catSubIdx = gens % Math.max(catSubs.length, 1);
      const catSubject = catSubs.length > 0
        ? catSubs[catSubIdx % catSubs.length]
        : pickSubject(dayTheme);

      const seed = Math.floor(Math.random() * 1e9);
      let raw;
      try {
        const prompt = `${catSubject}, ${dayTheme.tone} color palette, soft morning light, elegant, highly detailed, beautiful, no text, no letters, no numbers, no watermark, no signature`;
        raw = await genImage(prompt, seed);
      } catch (e) { defIdx++; continue; }

      let h; try { h = dhash(raw); } catch (e) { defIdx++; continue; }
      // dedup กับรูปใน cat_bank ของหมวดนั้น
      if (isDuplicate(h, cb[cat].hashes || [], PHASH_THRESHOLD)) { defIdx++; continue; }

      // หมวดธรรมะ: ~50% ใช้พุทธศาสนสุภาษิต (คำแปลไทย) ที่เหลือใช้คำอวยพรหมวด
      let blessing;
      if (cat === 'dharma' && Math.random() < 0.5) {
        blessing = pickDhammaProverb().th;
      } else {
        blessing = pickCatBlessing(cat) || NEUTRAL_BLESSINGS[Math.floor(Math.random() * NEUTRAL_BLESSINGS.length)];
      }
      // คำขึ้นต้นเฉพาะหมวด (เช่น "สุขสันต์วันเกิด") — หมวดทั่วไปคืน null → ภาพสะอาดไม่มีหัว
      const catHl = catHeadlineFor(cat, cb[cat].count);
      let card;
      try { card = await renderCard({ raw, blessing, withDay: false, headlineOverride: catHl || '' }); } catch (e) { defIdx++; continue; }
      if (!card || card.length < 2000) { defIdx++; continue; }
      const r = await panel(card);
      // keep-rate: ถ้า vision ใช้ไม่ได้ชั่วคราว (timeout/abort → ไม่มี voter ตอบ = 'pending')
      // ให้เก็บรูปไว้ (รูป gen สะอาด ไม่มีตัวอักษรอยู่แล้ว) แทนที่จะทิ้งทั้งหมด
      // แต่ถ้า vision "ปัดตกจริง" (reject: veto/คะแนนต่ำ) ยังทิ้งตามเดิม
      const visionDown = r.decision === 'pending' && (r.perAI || []).every(a => !a.scores);
      if (r.decision !== 'keep' && !visionDown) { defIdx++; continue; }
      const keepScore = r.decision === 'keep' ? r.score : 60;

      // บันทึกลง cat_bank
      const catDir = path.join(CAT_BANK_DIR, cat);
      fs.mkdirSync(catDir, { recursive: true });
      const fname = `cat_${cat}_${Date.now()}_${gens}.jpg`;
      fs.writeFileSync(path.join(catDir, fname), card);
      if (!cb[cat].hashes) cb[cat].hashes = [];
      cb[cat].hashes.push(hashToStr(h));
      cb[cat].images.push({ file: fname, score: keepScore, blessing, src: null, headline: catHl || '' });
      cb[cat].count = cb[cat].images.length;
      saveCatBank(cb);
      console.log(`  ✓ cat_bank[${cat}] +1 (${cb[cat].count}/${CAT_BANK_TARGET})${visionDown ? ' [vision down→trust]' : ''}`);

      // ถ้าหมวดนี้ครบแล้ว ดึงออกจาก deficit
      if (cb[cat].count >= CAT_BANK_TARGET) {
        deficit.splice(defIdx, 1);
        console.log(`  ✅ cat_bank[${cat}] ครบ ${CAT_BANK_TARGET} รูปแล้ว`);
      } else {
        defIdx++;
      }
    }

    // สรุป cat_bank
    const cbFinal = loadCatBank();
    const totalCatImgs = ALL_CATEGORIES.reduce((s, c) => s + cbFinal[c].count, 0);
    const fullCats = ALL_CATEGORIES.filter(c => cbFinal[c].count >= CAT_BANK_TARGET).length;
    console.log(`  cat_bank รวม: ${totalCatImgs} รูป (${fullCats}/${ALL_CATEGORIES.length} หมวดเต็ม)`);

    // 3b) เติม evergreen fallback (เฉพาะตอน deck รายวันเต็มแล้วเท่านั้น — ลำดับท้ายสุด)
    const ever = loadEver();
    while (st.images.length >= TARGET && ever.images.length < EVERGREEN_TARGET && timeLeft() > 120000 && gens < MAX_GEN_PER_RUN) {
      gens++;
      const subject = pickSubject(dayTheme);
      const seed = Math.floor(Math.random() * 1e9);
      let raw;
      try { raw = await genImage(`${subject}, soft golden morning light, dreamy, elegant, highly detailed, beautiful, no text, no letters, no numbers, no watermark`, seed); }
      catch (e) { continue; }
      let h; try { h = dhash(raw); } catch (e) { continue; }
      if (isDuplicate(h, ever.hashes, PHASH_THRESHOLD)) continue;

      const blessing = NEUTRAL_BLESSINGS[Math.floor(Math.random() * NEUTRAL_BLESSINGS.length)];
      let card;
      try { card = await renderCard({ raw, blessing, withDay: false }); } catch (e) { continue; }
      if (!card || card.length < 2000) continue;
      const r = await panel(card);
      if (r.decision !== 'keep') continue;

      const rawName = `base_${Date.now()}_${gens}.jpg`;
      const cardName = `ever_${Date.now()}_${gens}.jpg`;
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
  saveRecentHashes(recentHashes, targetISO);  // บันทึก hash 7 วันกันภาพซ้ำข้ามสัปดาห์
  console.log(`=== [done] target ${targetISO} เก็บ ${st.images.length}/${TARGET} ค้าง ${st.pending.length} gens ${gens} เหลือเวลา ${Math.round(timeLeft() / 1000)}s ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
