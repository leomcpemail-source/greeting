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
  const body = JSON.stringify({
    model: THAILLM_MODEL,
    messages: [{ role: "system", content: PERSONA }, { role: "user", content: userText.slice(0, 1000) }],
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

// ── (เฟสถัดไป) ผู้ใช้ส่งรูปตัวเองมา → ใส่คำอวยพรประจำวันแล้วส่งกลับ ──
// แผน: ดาวน์โหลดรูปจาก https://api-data.line.me/v2/bot/message/{messageId}/content
//      → overlay headline/พรประจำวัน (ต้องเรนเดอร์ฟอนต์ไทย — ทำใน pipeline canvas) → อัปโหลด → ส่ง image กลับ
async function handleUserPhoto(replyToken: string) {
  const data = await loadManifest();
  const headline = (data?.m?.headline || "").trim() || "อรุณสวัสดิ์";
  await lineReply(replyToken, [textMsg(
    `ได้รับรูปสวย ๆ ของคุณแล้วค่ะ 🥰\n` +
    `เร็ว ๆ นี้น้องใส่ใจจะช่วยใส่คำอวยพร “${headline}” ลงบนรูปของคุณ แล้วส่งกลับไปให้เลยนะคะ!\n` +
    `ระหว่างนี้พิมพ์ “ขอรูปสวัสดี” หรือชื่อหมวด (เช่น ดอกไม้, สุขภาพ, วันเกิด) มาได้เลย เดี๋ยวหารูปสวย ๆ ให้ค่ะ ☀️`,
  )]);
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

  const msg = ev.message || {};
  if (msg.type === "image") { await handleUserPhoto(ev.replyToken); return; }
  if (msg.type !== "text") {
    await lineReply(ev.replyToken, [textMsg("ขอบคุณนะคะ 😊 พิมพ์ข้อความคุยกับน้องใส่ใจ หรือพิมพ์ “ขอรูปสวัสดี” มาได้เลยค่ะ 🌸")]);
    return;
  }

  const text = String(msg.text || "").trim();
  const catId = detectCategory(text);
  if (wantsImage(text, catId)) { await replyGreetingImages(ev.replyToken, catId); return; }

  // คุย/ถามทั่วไป → ThaiLLM ในบทบาทน้องใส่ใจ
  const answer = await askThaiLLM(text);
  await lineReply(ev.replyToken, [textMsg(answer ||
    "ตอนนี้น้องใส่ใจคิดไม่ทันนิดนึงค่ะ 🥺 ลองพิมพ์ถามใหม่อีกครั้ง หรือพิมพ์ “ขอรูปสวัสดี” มาได้เลยนะคะ 🌸")]);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  if (!(await verifySignature(rawBody, signature))) return new Response("bad signature", { status: 401 });

  let payload: { events?: any[] };
  try { payload = JSON.parse(rawBody); } catch { return new Response("bad json", { status: 400 }); }

  // ตอบ 200 ให้ LINE เร็ว ๆ แล้วประมวลผลต่อเบื้องหลัง (กัน LINE retry ระหว่างรอ ThaiLLM)
  const work = Promise.all((payload.events ?? []).map((ev) => handleEvent(ev).catch(() => {})));
  // @ts-ignore EdgeRuntime มีบน Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work);
  else await work;

  return new Response("ok", { status: 200 });
});
