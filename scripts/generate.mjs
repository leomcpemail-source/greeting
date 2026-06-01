// scripts/generate.mjs
// รันโดย GitHub Actions ตอนดึก: gen รูปธีมตามวัน + กรองรูปแปลก + จัดการคลังคำอวยพร
// ใช้ fetch/fs ในตัวของ Node 20

import fs from 'node:fs';
import path from 'node:path';

// ---------- ตั้งค่า ----------
// GitHub Actions free tier: job timeout สูงสุด 1h30m (5400วิ)
// ประมาณการ: ~90วิ/รูป (จาก log จริง) × 40 รูป = 60 นาที + buffer 30 นาที = 90 นาที ✓
const TARGET = 40;               // ลดจาก 60 → 40 ให้พอดี timeout
const MAX_ATTEMPTS = 65;         // TARGET * 1.6
const IMG_SIZE = 800;
const MIN_GAP_MS = 15500;       // เว้นขั้นต่ำระหว่าง request Pollinations (โควต้า ~1/15วิ)
const VISION = true;            // กรองรูปอัตโนมัติ
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY    || '';
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
const TIME_RELAX_MS = 45 * 60 * 1000; // ผ่านไป 45 นาทีแล้วยังไม่ครบ MIN_KEEP → ผ่อนเกณฑ์
const REQUIRE_TEXT_SAFE = false;  // true = ทิ้งรูปที่ตรงกลางรกเกินไป (วางข้อความไม่สวย) ด้วย

// ── Cascade: Pollinations กรองหยาบก่อน → คะแนนก้ำกึ่งค่อยส่ง Gemini ชี้ขาด ──
// ฟรี/เร็วด้วย Pollinations เป็นด่านแรก, ใช้ Gemini (แม่นกว่า) เฉพาะรูปที่ตัดสินยาก
// → ประหยัดโควตา Gemini และมี fallback กลับ Pollinations ถ้า Gemini ล่ม/เต็มโควตา
const GEMINI_VISION = true;       // false = ใช้ Pollinations ล้วน (ปิด Gemini)
const BORDER_LO = 5;              // โซนก้ำกึ่ง: คะแนน Pollinations ในช่วง BORDER_LO..BORDER_HI
const BORDER_HI = 6;              //   เท่านั้นที่ส่งต่อให้ Gemini ตัดสินชี้ขาด
const GEMINI_VISION_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash']; // ลองตามลำดับ

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
    for (const model of ['gemini-3.5-flash', 'gemini-2.5-flash']) {
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

  // gen คำอวยพรก่อน loop รูป — ใช้เวลาแค่ ~5 วิ ไม่กระทบ budget
  // วันเทศกาล: gen TARGET คำด้วย Gemini (อิงเทศกาล 60% + ทั่วไป 40%) — ไม่ใช้ static 3 คำอย่างเดียว
  let blessings = await genBlessingsGemini({
    dayTh: dayTheme.th,
    headline,
    isFestival: !!fest,
    n: TARGET
  });
  console.log(`✓ ได้คำอวยพร ${blessings.length} คำ`);

  const dateThai = `วัน${dayTheme.th} ที่ ${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()+543}`;

  // ── (ออปชัน) เตรียมตัวประกอบภาพจริงด้วย headless browser — กันพัง: ล้มเหลว = ใช้โหมดรูปดิบ ──
  let renderer = null, rCounts = null;
  if (COMPOSITE_SCORING) {
    try {
      const { CompositeRenderer } = await import('./composite.mjs');
      renderer = new CompositeRenderer(INDEX_HTML_PATH);
      await renderer.init();
      rCounts = await renderer.page.evaluate(
        () => ({ frames: FRAMES.length, layouts: LAYOUTS.length, texts: TEXT_SIZES.length, overlays: OVERLAYS.length })
      );
      console.log(`✓ โหมดตรวจภาพประกอบจริง (composite) พร้อม — frames=${rCounts.frames} layouts=${rCounts.layouts}`);
    } catch (e) {
      console.log(`⚠️ เปิด composite ไม่สำเร็จ (${e.message}) — ใช้โหมดตรวจรูปดิบแทน`);
      if (renderer) await renderer.close();
      renderer = null;
    }
  }

  const images = [];   // path ตามลำดับที่เขียนไฟล์ (ใช้ตั้งชื่อ idx)
  const scored = [];   // { file, score, textSafe } เก็บคะแนนความสวยของแต่ละรูป
  const cards  = [];   // { img, fr, lay, tx, ov, bl, score } — คู่ที่ตรึง (เฉพาะโหมด composite)
  let attempt = 0;
  while (images.length < TARGET && attempt < MAX_ATTEMPTS) {
    attempt++;
    const elapsed = Date.now() - T0;
    const overBudget = elapsed > TIME_BUDGET_MS;
    // หยุดถ้าเวลาเกิน 75 นาที ไม่ว่าจะได้รูปครบหรือยัง
    if (elapsed > STOP_BEFORE_END_MS) {
      console.log(`[หยุด] เวลาผ่านไป ${Math.round(elapsed/60000)} นาที — หยุด gen เพื่อป้องกัน timeout`);
      break;
    }
    const seed = uniqueSeed();

    // วันเทศกาล: 40% ใช้ subject เทศกาล, 60% ใช้ subject ทั่วไป
    // วันปกติ: 100% ใช้ subject ทั่วไป
    let subject;
    if (fest && Math.random() < FEST_SUBJECT_RATIO) {
      subject = fest.subjects[Math.floor(Math.random() * fest.subjects.length)];
    } else {
      subject = pickSubject(theme);
    }
    const prompt =
      `${subject}, ${theme.tone} color palette, soft golden morning light, `
    + `dreamy, elegant, highly detailed, beautiful, `
    + `no text, no letters, no numbers, no watermark, no signature`;
    try {
      console.log(`[${attempt}] gen seed=${seed} (ได้แล้ว ${images.length}/${TARGET})${overBudget?' [เกินงบ-ไม่กรอง]':''}`);
      const buf = await genImage(prompt, seed);
      const file = `img/${String(images.length).padStart(2,'0')}.jpg`;

      // เลือกกรอบ/เลย์เอาต์/คำ สำหรับการ์ดใบนี้ แล้ว "ตรึง" ไว้ (เฉพาะโหมด composite)
      let combo = null;
      if (renderer && rCounts) {
        combo = {
          img: file,
          fr:  Math.floor(Math.random() * rCounts.frames),
          lay: Math.floor(Math.random() * rCounts.layouts),
          tx:  Math.floor(Math.random() * rCounts.texts),
          ov:  Math.floor(Math.random() * rCounts.overlays),
          bl:  blessings.length ? blessings[images.length % blessings.length] : 'ขอให้เป็นวันที่สดใส',
        };
      }

      let score = 7, textSafe = true, src = 'off';
      if (!overBudget) {
        // ประกอบภาพจริง (รูป+กรอบ+ข้อความ) ถ้าเปิด composite — ถ้า render พังก็ถอยไปตรวจรูปดิบ
        let assessBuf = buf, composite = false;
        if (renderer && combo) {
          try {
            const out = await renderer.render({
              imgDataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
              frameIdx: combo.fr, layoutIdx: combo.lay, txIdx: combo.tx, ovIdx: combo.ov,
              headline, blessing: combo.bl, dateThai, color: theme.color, color2: theme.c2,
              dayTh: dayTheme.th, size: 800
            });
            if (out && out.length > 2000) { assessBuf = out; composite = true; }
          } catch (e) { console.log(`    ! ประกอบภาพล้มเหลว: ${e.message} — ตรวจรูปดิบแทน`); }
        }
        const a = await assessImage(assessBuf, composite);
        score = a.score; textSafe = a.textSafe; src = (composite ? 'C:' : '') + a.src;
        // 1) พัง/ไม่เหมาะสม → ทิ้ง
        if (!a.ok) { console.log(`  ✗ vision: BAD ทิ้ง (${src})`); continue; }
        // 2) คะแนนต่ำกว่าเกณฑ์ → ทิ้ง — ผ่อนเกณฑ์เมื่อ: ใช้ attempts ไปมาก / เลย 45 นาที / ตามไม่ทัน MIN_KEEP
        const behindPace = images.length < MIN_KEEP && attempt > MAX_ATTEMPTS * 0.45;
        const relaxed = attempt > MAX_ATTEMPTS * SCORE_RELAX_AT || (Date.now() - T0) > TIME_RELAX_MS || behindPace;
        const floor = relaxed ? Math.max(3, MIN_SCORE - SCORE_RELAX_BY) : MIN_SCORE;
        if (score < floor) { console.log(`  ✗ สวยไม่พอ (คะแนน ${score} < ${floor}, ${src}) ทิ้ง`); continue; }
        // 3) (ออปชัน) ข้อความอ่านยาก/ตรงกลางรก → ทิ้ง
        if (REQUIRE_TEXT_SAFE && !textSafe && !relaxed) { console.log('  ✗ ข้อความอ่านยาก/ตรงกลางรก ทิ้ง'); continue; }
      }

      fs.writeFileSync(path.join(IMG_DIR, path.basename(file)), buf);
      images.push(file);
      scored.push({ file, score, textSafe });
      if (combo) { combo.score = score; cards.push(combo); }
      console.log(`  ✓ เก็บเป็น ${path.basename(file)} (คะแนน ${score}·${src}${textSafe?'':' /ตรงกลางรก'})`);
    } catch (e) {
      console.log('  ! error:', e.message);
    }
  }

  if (images.length === 0) throw new Error('gen ไม่ได้สักรูป — ยกเลิก');

  if (renderer) { try { await renderer.close(); } catch(e){} renderer = null; }

  // ปรับ blessings ให้พอดีกับจำนวนรูปที่ได้จริง
  if (blessings.length > 0 && blessings.length < images.length) {
    while (blessings.length < images.length) blessings.push(...blessings);
    blessings = blessings.slice(0, images.length);
  } else if (blessings.length > images.length) {
    blessings = blessings.slice(0, images.length);
  }

  // เรียงรูปคะแนนสูงไว้ก่อน (รูปที่ตรงกลางรกโดนหักครึ่งแต้มในการจัดเรียง)
  scored.sort((a, b) => (b.score - (b.textSafe ? 0 : 0.5)) - (a.score - (a.textSafe ? 0 : 0.5)));
  const sortedImages = scored.length ? scored.map(s => s.file) : images;
  const scores = scored.map(s => s.score);
  const avgScore = scores.length ? +(scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(2) : null;

  const manifest = {
    date: todayISO,
    dateThai: `วัน${dayTheme.th} ที่ ${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()+543}`,
    dayTh: dayTheme.th, dayEn: dayTheme.en,
    headline,
    isFestival: !!fest,
    festival: fest ? fest.headline : null,
    color: theme.color, color2: theme.c2,
    count: images.length,
    images: sortedImages,
    scores,        // คะแนนความสวย 1-10 เรียงตรงกับ images (สูง→ต่ำ)
    avgScore,      // คะแนนเฉลี่ยของวันนั้น (ดู trend คุณภาพได้)
    // cards[] = "การ์ดที่ตรึงไว้" (รูป+กรอบ+เลย์เอาต์+คำ) ที่ผ่านการตรวจภาพประกอบจริง
    // มีเฉพาะตอนเปิด COMPOSITE_SCORING ; ถ้าไม่มี index.html จะกลับไปสุ่มแบบเดิม
    cards: cards.length ? cards.slice().sort((a, b) => b.score - a.score) : undefined,
    blessings, version
  };
  fs.writeFileSync(path.join(OUT,'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`=== เสร็จ: ${images.length} รูป (คะแนนเฉลี่ย ${avgScore ?? '-'})${cards.length?` [composite: ${cards.length} การ์ดตรึง]`:''}, ${blessings.length} คำอวยพร${fest?' (เทศกาล: '+fest.headline+')':''} (ใช้เวลา ${Math.round((Date.now()-T0)/60000)} นาที) ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
