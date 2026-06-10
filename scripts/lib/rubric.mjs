// lib/rubric.mjs
// ให้คะแนน "การ์ดสำเร็จ" (composited: รูป+กรอบ+ข้อความ) ด้วย panel 2 AI
// แต่ละ AI คืน JSON คะแนนรายข้อ 0-10 -> โค้ดคูณน้ำหนักเป็น 0-100 -> เฉลี่ย 2 ตัว
//
// การออกแบบ: ไม่ผูกกับ endpoint ของ AI โดยตรง — รับ "ตัวเรียก vision" เป็น dependency
// (ส่ง fn ของ Pollinations / Gemini ที่พิสูจน์แล้วในโค้ดเดิมเข้ามา) จึงไม่ต้องเดา API

export const WEIGHTS = {
  clarity: 0.30,        // ความชัดของข้อความ
  appropriateness: 0.20, // ความเหมาะสมของข้อความอวยพร
  beauty: 0.20,         // สวยแบบผู้ใหญ่ไทยนิยม
  warmth: 0.15,         // อบอุ่นเป็นมิตร
  quality: 0.15,        // คุณภาพภาพ / ข้อผิดพลาด AI
};

export const RUBRIC_PROMPT = `You are judging a FINISHED Thai "good morning" greeting card (สวัสดีวันนี้) that already has a background photo/illustration, a decorative frame, and Thai greeting text composited together as one image. This card will be shared on LINE by Thai elderly users (age 55–80).

Score each criterion as an INTEGER 0–10 (0 = worst, 5 = mediocre, 10 = excellent). Be honest — use the full 0–10 range, do NOT cluster around 7.

1. clarity — Can the Thai greeting text be read clearly in under 2 seconds? Does it contrast well against the background? Would someone aged 65+ with average eyesight read it without effort? (0 = completely unreadable; 10 = crystal clear, large, high-contrast text)

2. appropriateness — Is the greeting text positive, polite, and culturally suitable for Thai elderly? No spelling errors, no strange words, no inappropriate content, no awkward English mixed in. (0 = offensive or unsuitable; 10 = perfectly warm Thai blessing)
   CRITICAL: Read EVERY piece of Thai text on the card carefully. The Thai must be natural, grammatically correct, with proper word order — exactly how a native Thai speaker would write a greeting. If ANY text is awkward, unnatural, wrongly ordered, truncated, or sounds machine-generated (for example "แด่คนวันเกิด" instead of the natural "สุขสันต์วันเกิด"), score 0–2. This audience is Thai elderly — broken Thai wording is unacceptable.

3. beauty — Does the image match the aesthetic preferences of Thai elderly users (age 55–80)?
   HIGH score (8–10): serene Buddha statues, Thai/Chinese temples, golden pagodas, lotus flowers, orchids, marigolds, vibrant tropical flowers, auspicious golden imagery, peaceful morning nature, soft warm light.
   MEDIUM score (5–7): pleasant generic flowers, cute landscapes, 3D cartoon animals.
   LOW score (1–4): dark/gloomy mood, cold abstract design, overly modern minimal, foreign-looking content.
   CRITICAL RULE: Buddhist and temple imagery (Buddha statues, Thai temples, pagodas, lotus) scores HIGH (8–10) for this audience — these users actively seek and prefer this content.

4. warmth — Does viewing this card feel joyful, peaceful, and shareable? Would a Thai grandmother be proud to send it to family on LINE? (0 = cold, unwelcoming; 10 = immediately warm and joyful)

5. quality — Is the image technically clean with no AI generation errors? Check: no garbled phantom text baked into the photo, no deformed anatomy, no broken/melted religious figures, clean composition. A slightly imperfect statue is fine if the overall impression is respectful. (0 = severely broken; 10 = flawless)

Reply ONLY with valid JSON — no markdown, no explanation, nothing else:
{"clarity":0,"appropriateness":0,"beauty":0,"warmth":0,"quality":0}`;

const KEYS = ["clarity", "appropriateness", "beauty", "warmth", "quality"];

export function parseRubric(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*?\}/); // ดึง JSON ก้อนแรก (เผื่อมี fence/ข้อความนำ)
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  const out = {};
  for (const k of KEYS) {
    const v = Number(o[k]);
    if (!Number.isFinite(v)) return null;
    out[k] = Math.max(0, Math.min(10, v));
  }
  return out;
}

// คะแนนถ่วงน้ำหนัก 0-100
export function weighted100(s) {
  let sum = 0;
  for (const k of KEYS) sum += s[k] * WEIGHTS[k];
  return Math.round(sum * 10); // (0-10 ถ่วงน้ำหนัก) * 10 = 0-100
}

// veto (safety floor): ข้อความไม่เหมาะสม/ภาษาไทยเพี้ยน (<=2) หรือ ภาพพังชัด -> ทิ้งทันที
// ขยายจาก ===0 เป็น <=2 (มิ.ย.2569): คำเรียงประโยคผิดอย่าง "แด่คนวันเกิด" มักได้ 1-2 ไม่ใช่ 0
function vetoed(s) {
  return s.appropriateness <= 2 || s.quality === 0;
}

/**
 * scorePanel(imageInput, callers, opts)
 *   imageInput : ส่งผ่านตรง ๆ ไปยัง caller fn (เช่น Buffer jpeg หรือ base64 — แล้วแต่ fn เดิม)
 *   callers    : [{ name, fn }] โดย fn(imageInput, prompt) => Promise<string|null> (raw text จาก AI)
 *   opts.passScore (default 50)  -> ผ่านเมื่อคะแนนรวม "เกิน" ค่านี้ (เกิน 50 = เกิน 5/10)
 *   opts.minClarity (default 5)  -> ความชัดข้อความต้อง >= ค่านี้ (เพราะหนัก 30%)
 *   opts.minVoters (default 2)   -> ต้องมี AI ตอบครบกี่ตัวถึงจะตัดสิน
 * คืน: { decision: 'keep'|'reject'|'pending', score, perAI, reason }
 */
export async function scorePanel(imageInput, callers, opts = {}) {
  const passScore = opts.passScore ?? 50;
  const minClarity = opts.minClarity ?? 5;
  const minVoters = opts.minVoters ?? 2;

  const results = await Promise.all(callers.map(async (c) => {
    try {
      const txt = await c.fn(imageInput, RUBRIC_PROMPT);
      return { name: c.name, scores: parseRubric(txt) };
    } catch (e) {
      return { name: c.name, scores: null, error: String(e?.message || e) };
    }
  }));

  const perAI = results.map(r => ({ name: r.name, scores: r.scores, error: r.error }));
  const valid = results.filter(r => r.scores);

  // ตอบไม่ครบ -> ค้างตรวจ (รอบหน้าตรวจซ้ำ ไม่ต้อง gen ใหม่)
  if (valid.length < minVoters) {
    return { decision: "pending", score: null, perAI, reason: `voters ${valid.length}/${minVoters}` };
  }

  // veto -> reject ทันทีแม้คะแนนรวมจะผ่าน
  if (valid.some(r => vetoed(r.scores))) {
    return { decision: "reject", score: null, perAI, reason: "veto: appropriateness <= 2 or quality = 0" };
  }

  // เฉลี่ยรายข้อ (2 ตัว: mean = median)
  const avg = {};
  for (const k of KEYS) avg[k] = valid.reduce((a, r) => a + r.scores[k], 0) / valid.length;
  const score = weighted100(avg);

  if (avg.clarity < minClarity) {
    return { decision: "reject", score, perAI, reason: `clarity ${avg.clarity.toFixed(1)} < ${minClarity}` };
  }
  if (score <= passScore) {
    return { decision: "reject", score, perAI, reason: `score ${score} <= ${passScore}` };
  }
  return { decision: "keep", score, perAI, reason: "ok" };
}
