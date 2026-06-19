// supabase/functions/line-webhook/index.ts
// Webhook ของ LINE OA "สวัสดีทุกวัน" — มีผู้ช่วยตัวละคร "น้องใส่ใจ" (เด็กสาวอายุ 20 ปี)
//   • follow   = บันทึกเพื่อน (active=true) + ทักทายแนะนำตัวน้องใส่ใจ
//   • unfollow = ตั้ง active=false
//   • message(text)  = น้องใส่ใจตอบ: ถ้าขอรูป → หารูปสวัสดีจากคลังตามหมวด ; ไม่งั้น → ถาม ThaiLLM ตอบ
//   • message(image) = (เฟสถัดไป) รับรูป user → ใส่คำอวยพรประจำวันแล้วส่งกลับ ; ตอนนี้ตอบรับแบบน่ารักไว้ก่อน
//
// ENV (secret ของ Edge Function):
//   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
//   THAILLM_API_KEY  (+ ออปชัน THAILLM_URL, THAILLM_MODEL)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (แพลตฟอร์มใส่ให้อัตโนมัติ)
// deploy: --no-verify-jwt (LINE ไม่ได้แนบ JWT)

const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const THAILLM_URL = Deno.env.get("THAILLM_URL") ?? "http://thaillm.or.th/api/v1/chat/completions";
const THAILLM_KEY = Deno.env.get("THAILLM_API_KEY") ?? "";
const THAILLM_MODEL = Deno.env.get("THAILLM_MODEL") ?? "typhoon-s-thaillm-8b-instruct";
const MKCARD_TOKEN = Deno.env.get("MKCARD_TOKEN") ?? "";   // internal token เรียก line-make-card

const BASE = "https://raw.githubusercontent.com/leomcpemail-source/greeting/daily-images";

// ── บุคลิกของน้องใส่ใจ (system prompt) ──
const PERSONA = [
  "คุณคือ “น้องใส่ใจ” ผู้ช่วยสาวอายุ 20 ปี ประจำ LINE Official Account “สวัสดีทุกวัน”",
  "นิสัยร่าเริง อบอุ่น สุภาพ ใส่ใจผู้สูงวัยเป็นพิเศษ เรียกตัวเองว่า “หนู” หรือ “น้องใส่ใจ” ลงท้าย “ค่ะ/นะคะ”",
  "ตอบเป็นภาษาไทยที่อ่านง่าย กระชับ เหมาะกับการอ่านบนมือถือ (ประมาณ 1–4 ประโยค) ใส่อีโมจิได้เล็กน้อยพอน่ารัก",
  "หน้าที่หลัก: พูดคุยเป็นเพื่อน ตอบคำถามทั่วไป และช่วยหารูปสวัสดี/คำอวยพรให้ผู้ใช้",
  "ถ้าไม่รู้คำตอบจริง ๆ หรือไม่แน่ใจ ห้ามแต่งข้อมูลเท็จเด็ดขาด ให้บอกตามตรงอย่างน่ารัก แล้วเสนอช่วยเรื่องอื่นหรือชวนคุยต่ออย่างสร้างสรรค์",
  "ถ้าผู้ใช้อยากได้รูปสวัสดี ให้บอกว่าพิมพ์คำว่า “ขอรูปสวัสดี” หรือชื่อหมวด (เช่น ดอกไม้ สุขภาพ วันเกิด) มาได้เลย",
  "หลีกเลี่ยงเรื่องการเมือง ความรุนแรง และเนื้อหาผู้ใหญ่ อย่างสุภาพ",
].join("\n");

// ── หมวด (ตรงกับ index.html / คลังรูป) ──
const CAT_LABEL: Record<string, string> = {
  flowers: "ดอกไม้", dharma: "ธรรมะ", inspire: "กำลังใจ", miss: "คิดถึง",
  birthday: "วันเกิด", elderly: "ผู้สูงวัย", health: "สุขภาพ", festival: "เทศกาล",
  family: "ครอบครัว", pets: "สัตว์เลี้ยง", coffee: "กาแฟ", nature: "ธรรมชาติ",
};
const CAT_KW: [RegExp, string][] = [
  [/ดอกไม้|ดอกกุหลาบ|กุหลาบ|มะลิ|ดอกบัว|บานชื่น|ช่อดอก/, "flowers"],
  [/พระ|ธรรมะ|ทำบุญ|วัด|มงคล|สวดมนต์|ไหว้พระ/, "dharma"],
  [/กำลังใจ|สู้ ?ๆ|ฮึบ|เป็นกำลังใจ|ให้กำลังใจ/, "inspire"],
  [/คิดถึง|ห่วงใย|ระลึกถึง/, "miss"],
  [/วันเกิด|สุขสันต์วันเกิด|hbd|happy birthday/i, "birthday"],
  [/ผู้สูง|สูงวัย|สูงอายุ|คุณตา|คุณยาย|ตายาย|ปู่ย่า|ตายาย/, "elderly"],
  [/สุขภาพ|แข็งแรง|หายป่วย|หายไว ?ๆ|สุขภาพดี/, "health"],
  [/เทศกาล|ปีใหม่|สงกรานต์|ลอยกระทง|วันพ่อ|วันแม่|ตรุษจีน/, "festival"],
  [/ครอบครัว|ลูกหลาน|พ่อแม่|ครอบครัวอบอุ่น/, "family"],
  [/สัตว์เลี้ยง|หมา|สุนัข|แมว|น้องหมา|น้องแมว|เหมียว/, "pets"],
  [/กาแฟ|coffee|ชายามเช้า/i, "coffee"],
  [/ธรรมชาติ|วิว|ภูเขา|ทะเล|น้ำตก|ทุ่ง|พระอาทิตย์/, "nature"],
];

function ictNow(): Date { return new Date(Date.now() + 7 * 3600 * 1000); }
function thaiDateISO(): string {
  const d = ictNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
// วัน/เดือนไทย + พ.ศ. สำหรับฉีดเข้า prompt (กัน LLM เดาวันเวลาเอง)
const WD = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const MO = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function nowContextTH(): string {
  const d = ictNow();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `วัน${WD[d.getUTCDay()]}ที่ ${d.getUTCDate()} ${MO[d.getUTCMonth()]} พ.ศ. ${d.getUTCFullYear() + 543} เวลาประมาณ ${hh}:${mm} น. (เวลาประเทศไทย)`;
}
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ── โหลด manifest ของวันนี้ (ไม่มีก็ evergreen) ──
async function loadManifest(): Promise<{ folder: string; m: any } | null> {
  for (const folder of [thaiDateISO(), "evergreen"]) {
    try {
      const r = await fetch(`${BASE}/img/${folder}/manifest.json?v=${Date.now()}`, { cache: "no-store" });
      if (r.ok) return { folder, m: await r.json() };
    } catch { /* try next */ }
  }
  return null;
}

// ── ตรวจลายเซ็น HMAC-SHA256(rawBody, channelSecret) ──
async function verifySignature(rawBody: string, signature: string): Promise<boolean> {
  if (!CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

// ── LINE API ──
async function lineReply(replyToken: string, messages: unknown[]) {
  if (!ACCESS_TOKEN) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  }).catch(() => {});
}
const textMsg = (text: string) => ({ type: "text", text: text.slice(0, 4900) });

// แสดง loading animation ("กำลังพิมพ์…") ในแชต — LINE ไม่มี API mark-as-read โดยตรง
// อันนี้คือสิ่งที่ใกล้เคียงที่สุด: โผล่ทันทีที่รับข้อความ = น้องใส่ใจเห็นแล้ว/กำลังตอบ
async function lineLoading(userId: string) {
  if (!ACCESS_TOKEN || !userId) return;
  await fetch("https://api.line.me/v2/bot/chat/loading/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ chatId: userId, loadingSeconds: 20 }),
  }).catch(() => {});
}

async function lineProfileName(userId: string): Promise<string | null> {
  if (!ACCESS_TOKEN) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    if (!r.ok) return null;
    return (await r.json()).displayName ?? null;
  } catch { return null; }
}

async function upsertFriend(userId: string, displayName: string | null) {
  await fetch(`${SUPABASE_URL}/rest/v1/line_friends`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId, display_name: displayName, active: true, followed_at: new Date().toISOString(), unfollowed_at: null }),
  }).catch(() => {});
}
async function deactivateFriend(userId: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/line_friends?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, unfollowed_at: new Date().toISOString() }),
  }).catch(() => {});
}

// ── ถาม ThaiLLM (OpenAI-compatible) ในบทบาทน้องใส่ใจ ── retry 1 ครั้งกัน 502/timeout ชั่วคราว
async function askThaiLLM(userText: string): Promise<string | null> {
  if (!THAILLM_KEY) return null;
  const sys = `${PERSONA}\n\nข้อมูลปัจจุบัน (ใช้อ้างอิงเมื่อถูกถามเรื่องวัน/เวลา ห้ามเดาเอง): วันนี้คือ ${nowContextTH()}`;
  const body = JSON.stringify({
    model: THAILLM_MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: userText.slice(0, 1000) }],
    max_tokens: 512,
    temperature: 0.6,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(THAILLM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${THAILLM_KEY}` },
        body,
        signal: AbortSignal.timeout(18000),
      });
      if (r.ok) {
        const j = await r.json();
        const txt = j?.choices?.[0]?.message?.content;
        if (typeof txt === "string" && txt.trim()) return txt.trim();
      }
    } catch { /* retry */ }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 700));
  }
  return null;
}

// ── หารูปสวัสดีจากคลัง ตามหมวด (ไม่มีหมวด = สุ่มทั่วไป) ──
function detectCategory(t: string): string | null {
  for (const [re, id] of CAT_KW) if (re.test(t)) return id;
  return null;
}
function wantsImage(t: string, catId: string | null): boolean {
  if (/(รูป|ภาพ|การ์ด|สติ๊กเกอร์|สติกเกอร์)/.test(t)) return true;
  if (/(ขอ|อยากได้|อยากดู|ส่ง|หา|เอา|มี)/.test(t) && (catId !== null || /สวัสดี|อวยพร|อรุณ/.test(t))) return true;
  return false;
}
async function replyGreetingImages(replyToken: string, catId: string | null) {
  const data = await loadManifest();
  if (!data) { await lineReply(replyToken, [textMsg("ขออภัยค่ะ ตอนนี้น้องใส่ใจหารูปไม่เจอเลย ลองใหม่อีกครั้งนะคะ 🙏")]); return; }
  const { folder, m } = data;
  const headline = (m.headline || "").trim() || "อรุณสวัสดิ์";
  let pool: any[] = [];
  if (catId && m.categories?.[catId]?.length) pool = m.categories[catId];
  else pool = (m.images || []).map((x: any) => (typeof x === "string" ? { file: x } : x));
  pool = pool.filter((x: any) => x && x.file);
  if (!pool.length) pool = (m.images || []).map((x: any) => (typeof x === "string" ? { file: x } : x)).filter((x: any) => x?.file);
  const picks = shuffle([...pool]).slice(0, 3);

  const label = catId ? `หมวด${CAT_LABEL[catId] || ""}` : "สวัสดี";
  const cap = `น้องใส่ใจหารูป${label}มาให้แล้วค่ะ 🌸\n${headline} ขอให้เป็นวันที่ดีนะคะ ☀️\n(กดค้างที่รูปเพื่อบันทึกหรือส่งต่อให้คนที่คุณรักได้เลยค่ะ)`;
  const msgs: unknown[] = [textMsg(cap)];
  for (const p of picks) {
    const url = `${BASE}/img/${folder}/${p.file}`;
    msgs.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  await lineReply(replyToken, msgs);
}

// อ่านขนาดภาพจาก header (JPEG/PNG) — ใช้เดาว่าเป็น "การ์ดมีตัวหนังสือแล้ว" (รูปจัตุรัส 1:1)
function imageSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) { // PNG
    return { w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] };
  }
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) { // JPEG
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}
// ดาวน์โหลดรูปแล้วเช็คว่าน่าจะเป็น "การ์ดที่มีตัวหนังสือแล้ว" (จัตุรัสเกือบเป๊ะ) ; null = เช็คไม่ได้
async function photoLooksTexted(messageId: string): Promise<boolean | null> {
  if (!ACCESS_TOKEN || !messageId) return null;
  try {
    const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const s = imageSize(new Uint8Array(await r.arrayBuffer()));
    if (!s || s.w <= 0 || s.h <= 0) return null;
    return Math.abs(s.w / s.h - 1) <= 0.05;
  } catch { return null; }
}
const WARN_TEXTED =
  "ขออภัยนะคะ 🙏 ภาพนี้มีข้อความอยู่แล้ว น้องใส่ใจเลยใส่คำอวยพรเพิ่มให้ไม่ได้ค่ะ (ของเดิมก็สวยอยู่แล้วน้า)\n" +
  "ถ้าอยากให้หนูช่วยใส่คำอวยพรดี ๆ ลองส่ง “รูปถ่ายที่ยังไม่มีตัวหนังสือ” มาได้เลยนะคะ เดี๋ยวหนูจัดให้สวย ๆ ค่ะ 💛";

// ── ผู้ใช้ส่งรูปมา → ชมรูปก่อน แล้วถามว่าจะให้ทำอะไร (ขั้น generate กำลังต่อ) ──
async function handleUserPhoto(replyToken: string) {
  await lineReply(replyToken, [textMsg(
    "ว้าว~ รูปสวยจังเลยค่ะ 😍✨ ถ่าย/เลือกได้ดีมากเลยน้า\n\n" +
    "น้องใส่ใจช่วยอะไรกับรูปนี้ดีคะ?\n" +
    "📸 อยากได้เป็น “ภาพสวัสดี” (ใส่คำอวยพร + กรอบสวย ๆ ประจำวัน) — พิมพ์ว่า “ทำภาพสวัสดี” ได้เลยค่ะ\n" +
    "หรือบอกน้องใส่ใจได้เลยว่าอยากให้ช่วยอะไร 💛",
  )]);
}
// ผู้ใช้ตอบว่าอยากทำภาพสวัสดีจากรูป
function wantsPhotoGreeting(t: string): boolean {
  return /(ทำภาพสวัสดี|ทำสวัสดี|ใส่คำอวยพร|ใส่ตัวหนังสือ|ทำการ์ด|ทำเลย)/.test(t);
}
// คำชม/ขอบคุณ/ตอบรับสั้น ๆ — ไม่ใช่คำสั่งให้ทำภาพ (กันระบบสร้างภาพซ้ำตอน user แค่ชม)
function isAck(t: string): boolean {
  const s = t.trim();
  if (s.length > 25) return false; // ข้อความยาว = น่าจะมีเจตนาจริง
  if (/(ทำ|สร้าง|แก้|เปลี่ยน|ขอรูป|อยากได้|ใส่)/.test(s)) return false;
  return /(เยี่ยม|ดีมาก|ดีจ้|ดีจัง|สวยจัง|สวยมาก|สวยดี|เก่งมาก|ขอบคุณ|ขอบใจ|โอเค|^ok|^okay|👍|🙏|❤️|🥰|😍|น่ารัก|ชอบมาก|สุดยอด|เลิศ|ปัง|^ดี$|^เยี่ยม$|^เริ่ด|งดงาม)/i.test(s);
}
// ข้อความจากปุ่ม rich menu "ส่งรูปทำภาพสวัสดี" — เป็น "จุดเริ่ม" ไม่ใช่คำสั่งทำกับรูปเก่า
const MENU_PHOTO_TRIGGER = "อยากทำภาพสวัสดีจากรูปของฉัน 📷";
const MENU_STAGE = "-"; // ค่าใน staged เมื่อเป็นการกดเมนู (ยังไม่มีรูปใหม่)
const SEND_PHOTO_PROMPT =
  "ได้เลยค่ะ! 📷 ส่งรูปถ่ายที่อยากให้น้องใส่ใจช่วยทำเป็น “ภาพสวัสดี” มาได้เลยนะคะ\n" +
  "(เลือกรูปสวย ๆ ที่ยังไม่มีตัวหนังสือนะคะ เดี๋ยวหนูใส่คำอวยพร + กรอบประจำวันให้สวย ๆ ค่ะ 💛)";
// ถาม user เมื่อมี "ภาพเดิมค้างอยู่" แล้วส่งรูปใหม่ / กดเมนูเข้ามาอีก
const CONFLICT_NEW_PHOTO =
  "น้องใส่ใจเห็นว่ามี “ภาพเดิม” ที่ส่งมาก่อนหน้านี้ค้างอยู่ค่ะ 🖼️\n" +
  "อยากให้หนู “ทำใหม่” โดยใช้รูปที่เพิ่งส่งมา หรือ “ใช้ภาพเดิม” ดีคะ?\n" +
  "พิมพ์ว่า “ทำใหม่” หรือ “ใช้ภาพเดิม” มาได้เลยนะคะ 💛";
const CONFLICT_MENU =
  "ตอนนี้ยังมี “ภาพเดิม” ที่ส่งมาค้างอยู่ค่ะ 🖼️\n" +
  "อยากให้หนู “ใช้ภาพเดิม” ทำภาพสวัสดีต่อ หรือ “ทำใหม่” (ส่งรูปใหม่) ดีคะ?\n" +
  "พิมพ์ว่า “ใช้ภาพเดิม” หรือ “ทำใหม่” มาได้เลยนะคะ 💛";
const REDO_NEW = /(ทำใหม่|รูปใหม่|ภาพใหม่|อันใหม่|เริ่มใหม่|ส่งใหม่|ใช้.*ใหม่|ลบ)/;
const USE_OLD = /(ใช้.*(เดิม|เก่า)|ภาพเดิม|รูปเดิม|อันเดิม|ของเดิม|เดิม|อันเก่า|เก่า)/;

// จำรูปล่าสุดที่ user ส่งมา (ตาราง line_photo_pending) เพื่อใช้ตอนยืนยัน ; เคลียร์ staged ทุกครั้งที่ตั้งรูป active ใหม่
async function upsertPhotoPending(userId: string, messageId: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/line_photo_pending`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId, message_id: messageId, created_at: new Date().toISOString(), staged_message_id: null, staged_at: null }),
  }).catch(() => {});
}
// พักรูป/คำขอใหม่ไว้ "รอ user ตัดสินใจ" (staged) โดยไม่ทับรูป active เดิม
async function stagePhoto(userId: string, stagedId: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/line_photo_pending?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify({ staged_message_id: stagedId, staged_at: new Date().toISOString() }),
  }).catch(() => {});
}
async function clearStaged(userId: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/line_photo_pending?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify({ staged_message_id: null, staged_at: null }),
  }).catch(() => {});
}
// รูปที่เพิ่งส่งใช้ทำภาพได้ภายในกรอบเวลานี้ — กันการหยิบ "รูปเก่า" ที่ค้างมาทำซ้ำ (บั๊กถามวน/เตือนผิด)
const PENDING_FRESH_MS = 5 * 60 * 1000; // 5 นาที
async function getPhotoPending(userId: string): Promise<{ id: string; fresh: boolean; staged: string | null; stagedFresh: boolean } | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/line_photo_pending?user_id=eq.${encodeURIComponent(userId)}&select=message_id,created_at,staged_message_id,staged_at`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    if (!r.ok) return null;
    const row = (await r.json())?.[0];
    if (!row?.message_id) return null;
    const ts = Date.parse(row.created_at || "");
    const fresh = Number.isFinite(ts) ? (Date.now() - ts) <= PENDING_FRESH_MS : true;
    const sts = Date.parse(row.staged_at || "");
    const stagedFresh = Number.isFinite(sts) ? (Date.now() - sts) <= PENDING_FRESH_MS : false;
    return { id: row.message_id, fresh, staged: row.staged_message_id || null, stagedFresh };
  } catch { return null; }
}
async function deletePhotoPending(userId: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/line_photo_pending?user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" } }).catch(() => {});
}
async function triggerMakeCard(userId: string, messageId: string, bless = "") {
  await fetch(`${SUPABASE_URL}/functions/v1/line-make-card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: MKCARD_TOKEN, userId, messageId, bless }),
  }).catch(() => {});
}
// แยกคำอวยพรที่ user อยากแก้: "แก้คำอวยพรเป็น ..." / "เปลี่ยนข้อความเป็น ..." (fallback ถ้า LLM ล่ม)
function parseCustomBless(t: string): string | null {
  const m = t.match(/(?:แก้|เปลี่ยน|ขอแก้|ขอเปลี่ยน)\s*(?:ไข|คำ)?\s*(?:คำอวยพร|ข้อความ|คำ)\s*(?:ใหม่)?\s*(?:เป็น|ว่า|:)\s*(.+)/);
  return m && m[1] && m[1].trim() ? m[1].trim().slice(0, 120) : null;
}

const CATS_SET = new Set(["flowers", "dharma", "inspire", "miss", "birthday", "elderly", "health", "festival", "family", "pets", "coffee", "nature"]);

// ── ตัวจำแนกเจตนา (intent) ด้วย ThaiLLM — ตีความแม้พิมพ์ไม่เป๊ะ + รู้บริบทว่าเพิ่งส่งรูปไหม ──
const INTENT_SYS = [
  "คุณคือ “น้องใส่ใจ” ผู้ช่วยสาวอายุ 20 ของ LINE “สวัสดีทุกวัน” พูดจาอบอุ่นน่ารัก ลงท้าย ค่ะ/นะคะ",
  "หน้าที่: วิเคราะห์ “เจตนา” ของผู้ใช้จากข้อความ (ผู้ใช้พิมพ์ไม่เป๊ะ มีคำผิดได้ ให้ตีความตามความหมาย) แล้วตอบกลับเป็น JSON ล้วน ๆ เท่านั้น ห้ามมีข้อความอื่นนอก JSON",
  'รูปแบบ: {"action":"make_card|edit_blessing|get_image|chat","blessing":"","category":"","reply":""}',
  "- make_card: อยากให้เอา “รูปที่ส่งมา” มาทำเป็นภาพสวัสดี (ใส่คำอวยพร+กรอบ) เช่น ทำภาพสวัสดี, ทำการ์ดให้หน่อย, เอารูปนี้ทำสวัสดี, สร้างให้หน่อย, เอาเลย",
  '- edit_blessing: อยากแก้/เปลี่ยน “คำอวยพรบนภาพ” → ดึงข้อความคำอวยพรใหม่ใส่ใน "blessing" (เช่น แก้ไขคำอวยพรเป็น..., เปลี่ยนข้อความเป็น..., ขอข้อความว่า..., ไม่เอาอันเดิมขอเป็น...)',
  '- get_image: ขอ “รูปสวัสดีจากคลัง” (ไม่เกี่ยวกับรูปที่ส่งมา) เช่น ขอรูปสวัสดี, ขอรูปดอกไม้ → ถ้าระบุหมวดใส่รหัสใน "category" จาก flowers,dharma,inspire,miss,birthday,elderly,health,festival,family,pets,coffee,nature ไม่ระบุใส่ ""',
  '- chat: พูดคุย/ถามทั่วไป รวมถึง “คำชม/ขอบคุณ/ตอบรับ” (เช่น เยี่ยมมาก, ดีมาก, สวยจัง, ขอบคุณ, โอเค) → เขียนคำตอบแบบน้องใส่ใจสั้น ๆ อบอุ่นใน "reply" (ถ้าไม่รู้จริงห้ามมั่ว)',
  "สำคัญมาก: คำชม/ขอบคุณ/ตอบรับ (เยี่ยม, ดีมาก, สวยจัง, ขอบคุณ, โอเค ฯลฯ) = chat เสมอ ห้ามตีความเป็น make_card/edit_blessing แม้จะเพิ่งส่งรูปมา",
  "make_card เลือกเฉพาะเมื่อผู้ใช้ “สั่งให้ทำ/สร้าง” ภาพชัดเจนเท่านั้น ; edit_blessing เฉพาะเมื่อมีข้อความคำอวยพรใหม่จริง ๆ",
  "ถ้า “มีรูปที่เพิ่งส่งมา” และข้อความสั่งทำ/ใส่คำ/แก้คำชัดเจน ให้เลือก make_card หรือ edit_blessing (อย่าเลือก get_image)",
  "ตอบ JSON อย่างเดียว",
].join("\n");

function extractJson(s: string): any | null {
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
async function classifyIntent(text: string, hasPhoto: boolean): Promise<any | null> {
  if (!THAILLM_KEY) return null;
  const sys = `${INTENT_SYS}\nบริบท: ผู้ใช้ตอนนี้${hasPhoto ? "มีรูปที่เพิ่งส่งมา รอทำเป็นภาพสวัสดี" : "ยังไม่ได้ส่งรูปเข้ามา"} · วันนี้คือ ${nowContextTH()}`;
  const body = JSON.stringify({ model: THAILLM_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: String(text).slice(0, 800) }], max_tokens: 400, temperature: 0.2 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(THAILLM_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${THAILLM_KEY}` }, body, signal: AbortSignal.timeout(18000) });
      if (r.ok) {
        const j = await r.json();
        const obj = extractJson(j?.choices?.[0]?.message?.content || "");
        if (obj && typeof obj.action === "string") return obj;
      }
    } catch (_e) { /* retry */ }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 600));
  }
  return null;
}

const WELCOME = [
  "สวัสดีค่ะ หนูชื่อ “น้องใส่ใจ” เป็นผู้ช่วยประจำที่นี่เองค่ะ 🌸",
  "ทุกเช้า 6 โมง หนูจะส่งรูปสวัสดีพร้อมคำอวยพรดี ๆ มาให้ทุกวันเลยนะคะ ☀️",
  "อยากได้รูปสวัสดีเมื่อไหร่ พิมพ์ “ขอรูปสวัสดี” หรือจะคุยเล่น/ถามอะไรกับหนูก็ได้นะคะ 💛",
].join("\n");

async function handleEvent(ev: any) {
  const userId = ev?.source?.userId as string | undefined;
  if (ev.type === "follow" && userId) {
    const name = await lineProfileName(userId);
    await upsertFriend(userId, name);
    if (ev.replyToken) await lineReply(ev.replyToken, [textMsg(WELCOME)]);
    return;
  }
  if (ev.type === "unfollow" && userId) { await deactivateFriend(userId); return; }
  if (ev.type !== "message" || !ev.replyToken) return;

  if (userId) await lineLoading(userId);   // โชว์ "กำลังพิมพ์…" ทันที = น้องใส่ใจเห็นข้อความแล้ว

  const msg = ev.message || {};
  if (msg.type === "image") {
    // ถ้ารูปนี้ "มีตัวหนังสืออยู่แล้ว" (จัตุรัส ~1:1) → เตือนทันที + ไม่เก็บเป็น pending (กันถามวน/ทำซ้อนตัวอักษร)
    const texted = userId && msg.id ? await photoLooksTexted(msg.id) : null;
    if (texted === true) {
      if (userId) await deletePhotoPending(userId);
      await lineReply(ev.replyToken, [textMsg(WARN_TEXTED)]);
      return;
    }
    // ถ้ายังมี "ภาพเดิม" ค้างอยู่ (ภายใน 5 นาที) → ไม่ทับทันที แต่ถาม user ก่อน
    const cur = userId ? await getPhotoPending(userId) : null;
    if (cur && cur.fresh && userId && msg.id) {
      await stagePhoto(userId, msg.id);   // พักรูปใหม่ไว้ รอ user ตัดสินใจ
      await lineReply(ev.replyToken, [textMsg(CONFLICT_NEW_PHOTO)]);
      return;
    }
    if (userId && msg.id) await upsertPhotoPending(userId, msg.id);   // จำรูปไว้เผื่อสั่งทำภาพสวัสดี
    await handleUserPhoto(ev.replyToken);
    return;
  }
  if (msg.type !== "text") {
    await lineReply(ev.replyToken, [textMsg("ขอบคุณนะคะ 😊 พิมพ์ข้อความคุยกับน้องใส่ใจ หรือพิมพ์ “ขอรูปสวัสดี” มาได้เลยค่ะ 🌸")]);
    return;
  }

  const text = String(msg.text || "").trim();
  // ใช้เฉพาะ "รูปที่เพิ่งส่งมา" เท่านั้น (รูปเก่าค้าง = ไม่นับ) เพื่อกันการทำซ้ำ/เตือนผิดกับรูปเดิม
  const pendingRow = userId ? await getPhotoPending(userId) : null;
  const freshPhoto = pendingRow && pendingRow.fresh ? pendingRow.id : null;
  const noPhotoMsg = "ส่งรูปถ่ายที่อยากทำเป็นภาพสวัสดีมาก่อนนะคะ 📷 (เป็นรูปที่ยังไม่มีตัวหนังสือ) แล้วบอกหนูได้เลยค่ะ 🌸";

  // ── กำลังรอ user ตัดสินใจเรื่อง "ภาพเดิมค้างอยู่" (staged) → จัดการคำตอบก่อนอย่างอื่น ──
  if (userId && pendingRow && pendingRow.fresh && pendingRow.staged && pendingRow.stagedFresh) {
    if (REDO_NEW.test(text)) {
      if (pendingRow.staged === MENU_STAGE) {        // กดเมนู (ไม่มีรูปใหม่) → ลบของเดิม ชวนส่งรูปใหม่
        await deletePhotoPending(userId);
        await lineReply(ev.replyToken, [textMsg(SEND_PHOTO_PROMPT)]);
      } else {                                         // มีรูปใหม่รออยู่ → เลื่อนเป็น active แล้วทำเลย
        await upsertPhotoPending(userId, pendingRow.staged);
        await lineReply(ev.replyToken, [textMsg("ได้เลยค่ะ! 🎨 ใช้รูปใหม่ทำภาพสวัสดี กำลังทำให้เลย รอแป๊บนะคะ ✨")]);
        await triggerMakeCard(userId, pendingRow.staged);
      }
      return;
    }
    if (USE_OLD.test(text)) {                          // ใช้ภาพเดิม → ทิ้ง staged แล้วทำจากรูปเดิม
      await upsertPhotoPending(userId, pendingRow.id); // ต่ออายุ + เคลียร์ staged
      await lineReply(ev.replyToken, [textMsg("ได้เลยค่ะ ใช้ภาพเดิมนะคะ 🎨 กำลังทำภาพสวัสดีให้เลย รอแป๊บนะคะ ✨")]);
      await triggerMakeCard(userId, pendingRow.id);
      return;
    }
    // ตอบไม่ตรง → เคลียร์สถานะรอเลือก แล้วทำงานปกติต่อ (กันค้างวน)
    await clearStaged(userId);
  }

  // ปุ่ม rich menu = จุดเริ่ม → ไม่มีรูปสด: ชวนส่งรูป ; มีรูปเดิมค้าง: ถามก่อนว่าจะใช้เดิมหรือทำใหม่
  if (text === MENU_PHOTO_TRIGGER) {
    if (freshPhoto && userId) {
      await stagePhoto(userId, MENU_STAGE);
      await lineReply(ev.replyToken, [textMsg(CONFLICT_MENU)]);
    } else {
      await lineReply(ev.replyToken, [textMsg(SEND_PHOTO_PROMPT)]);
    }
    return;
  }

  // ผู้ใช้แค่ชม/ขอบคุณ (เช่น "เยี่ยมมาก") → คุยตอบ ไม่สร้างภาพซ้ำ แม้จะมีรูป pending อยู่
  if (isAck(text)) {
    const a = await askThaiLLM(text);
    await lineReply(ev.replyToken, [textMsg(a || "ขอบคุณนะคะ 🥰 ถ้าอยากให้น้องใส่ใจช่วยอะไรอีก บอกได้เลยค่ะ 💛")]);
    return;
  }

  // ── ให้ ThaiLLM ตีความเจตนาก่อน (พิมพ์ไม่เป๊ะก็เข้าใจ) ──
  const intent = await classifyIntent(text, !!freshPhoto);
  if (intent && intent.action) {
    const act = intent.action;
    if (act === "edit_blessing" || act === "make_card") {
      if (freshPhoto) {
        const bless = act === "edit_blessing" ? String(intent.blessing || "").trim().slice(0, 120) : "";
        await lineReply(ev.replyToken, [textMsg(bless
          ? "ได้เลยค่ะ! 🎨 กำลังแก้คำอวยพรบนภาพให้ใหม่ รอแป๊บนะคะ ✨"
          : "ได้เลยค่ะ! 🎨 กำลังทำภาพสวัสดีจากรูปของคุณ รอแป๊บนะคะ ส่งให้ภายในไม่กี่อึดใจ ✨")]);
        if (userId) await upsertPhotoPending(userId, freshPhoto); // ต่ออายุ session แก้ไข
        await triggerMakeCard(userId!, freshPhoto, bless);
      } else {
        await lineReply(ev.replyToken, [textMsg(noPhotoMsg)]);
      }
      return;
    }
    if (act === "get_image") {
      await replyGreetingImages(ev.replyToken, CATS_SET.has(intent.category) ? intent.category : null);
      return;
    }
    // action=chat → ตอบด้วย persona เต็มของน้องใส่ใจ (ใช้ reply จาก classifier เป็นสำรอง)
    const a = await askThaiLLM(text);
    await lineReply(ev.replyToken, [textMsg(a || String(intent.reply || "").trim() ||
      "ตอนนี้น้องใส่ใจคิดไม่ทันนิดนึงค่ะ 🥺 ลองพิมพ์ใหม่อีกครั้งนะคะ")]);
    return;
  }

  // ── LLM ล่ม → ใช้ regex สำรอง ──
  const cb = parseCustomBless(text);
  if (cb && freshPhoto) { await lineReply(ev.replyToken, [textMsg("ได้เลยค่ะ! 🎨 กำลังแก้คำอวยพรบนภาพให้ใหม่ รอแป๊บนะคะ ✨")]); if (userId) await upsertPhotoPending(userId, freshPhoto); await triggerMakeCard(userId!, freshPhoto, cb); return; }
  if (wantsPhotoGreeting(text)) {
    if (freshPhoto) { await lineReply(ev.replyToken, [textMsg("ได้เลยค่ะ! 🎨 กำลังทำภาพสวัสดีจากรูปของคุณ รอแป๊บนะคะ ✨")]); if (userId) await upsertPhotoPending(userId, freshPhoto); await triggerMakeCard(userId!, freshPhoto); }
    else await lineReply(ev.replyToken, [textMsg(noPhotoMsg)]);
    return;
  }
  const catId = detectCategory(text);
  if (wantsImage(text, catId)) { await replyGreetingImages(ev.replyToken, catId); return; }
  const answer = await askThaiLLM(text);
  await lineReply(ev.replyToken, [textMsg(answer ||
    "ตอนนี้น้องใส่ใจคิดไม่ทันนิดนึงค่ะ 🥺 ลองพิมพ์ถามใหม่อีกครั้ง หรือพิมพ์ “ขอรูปสวัสดี” มาได้เลยนะคะ 🌸")]);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  // ถ้าตั้ง CHANNEL_SECRET ไว้ → ตรวจลายเซ็น ; ถ้ายังไม่ได้ตั้ง → ข้าม (interim) เพื่อให้บอตตอบได้
  if (CHANNEL_SECRET) {
    if (!(await verifySignature(rawBody, signature))) return new Response("bad signature", { status: 401 });
  } else {
    console.warn("LINE_CHANNEL_SECRET not set — skipping signature verification (set it to secure the webhook)");
  }

  let payload: { events?: any[] };
  try { payload = JSON.parse(rawBody); } catch { return new Response("bad json", { status: 400 }); }

  // ตอบ 200 ให้ LINE เร็ว ๆ แล้วประมวลผลต่อเบื้องหลัง (กัน LINE retry ระหว่างรอ ThaiLLM)
  const work = Promise.all((payload.events ?? []).map((ev) => handleEvent(ev).catch(() => {})));
  // @ts-ignore EdgeRuntime มีบน Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work);
  else await work;

  return new Response("ok", { status: 200 });
});
