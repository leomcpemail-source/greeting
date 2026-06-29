// supabase/functions/line-checkin/index.ts
// ทักทายเชิงรุกตามเวลาที่ user มัก active (เว้นระยะ ~2-3 วัน) — cron รายชั่วโมง
// ทักเฉพาะ "คนที่เคยคุยจริง" หรือ "คนที่แอดมินตั้งใส่ใจเป็นพิเศษ" ; เว้น cooldown ; ข้ามคน opt-out
// ข้อความอบอุ่น ส่วนตัว (ใช้ชื่อ + หมวดรูปที่ชอบ) + มีปุ่มขอพัก ("พักก่อน") เสมอ
// auth: cron เท่านั้น (header x-cron-key)
//
// ENV: LINE_CHANNEL_ACCESS_TOKEN, CRON_KEY, (แพลตฟอร์มใส่ให้) SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const G = (globalThis as any).__SEC ?? {};
const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || G.AT || "";
const CRON_KEY = Deno.env.get("CRON_KEY") || G.CRON || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || G.URL || "https://iuyiwpoupnuxnohpatyw.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || G.SK || "";
const BASE = "https://raw.githubusercontent.com/leomcpemail-source/greeting/daily-images";

const COOLDOWN_HOURS = 60;   // เว้นอย่างน้อย ~2.5 วัน → ~2-3 ครั้ง/สัปดาห์
const DEFAULT_HOUR = 19;     // คนที่เดาเวลาไม่ได้ (เช่น care ที่ยังไม่เคยคุย) → ใช้ 1 ทุ่ม
const MAX_PER_RUN = 40;

const CAT_LABEL: Record<string, string> = {
  flowers: "ดอกไม้", dharma: "ธรรมะ", inspire: "กำลังใจ", miss: "คิดถึง", birthday: "วันเกิด",
  elderly: "ผู้สูงวัย", health: "สุขภาพ", festival: "เทศกาล", family: "ครอบครัว", pets: "สัตว์เลี้ยง",
  coffee: "กาแฟ", nature: "ธรรมชาติ",
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-cron-key", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function ictNow(): Date { return new Date(Date.now() + 7 * 3600 * 1000); }
function ictHour(): number { return ictNow().getUTCHours(); }
function thaiDateISO(): string { const d = ictNow(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }
function pick<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }

function cleanName(dn: string | null): string {
  if (!dn) return "";
  let n = String(dn).replace(/\([^)]*\)/g, " ").replace(/[\p{Extended_Pictographic}‍️]/gu, "").replace(/\s+/g, " ").trim();
  return n.length > 20 ? n.slice(0, 20).trim() : n;
}

function greetText(name: string, favCat: string | null): string {
  const hi = name ? `คุณ ${name}` : "คุณ";
  const openers = [
    `สวัสดีค่ะ ${hi} 🌸 ว่าง ๆ หนูแวะมาทักทาย วันนี้เป็นยังไงบ้างคะ?`,
    `${hi}คะ 💛 หนูคิดถึงเลยแวะมาทักหน่อย วันนี้พอจะมีอะไรดี ๆ บ้างไหมคะ?`,
    `เฮลโหล ${hi} 🌷 หนูแวะมาส่งกำลังใจให้ค่ะ ขอให้วันนี้เป็นวันที่ดีนะคะ`,
    `${hi}คะ ☀️ หนูแวะมาทักทายเฉย ๆ ค่ะ หวังว่าวันนี้จะเป็นวันสบาย ๆ ของคุณนะคะ`,
  ];
  const favTxt = favCat && CAT_LABEL[favCat] ? `หนูเลยเลือกรูป${CAT_LABEL[favCat]}ที่คุณชอบมาฝากด้วยค่ะ 🎁` : "";
  const tail = "ถ้าอยากได้รูปสวัสดี อยากทำการ์ดจากรูปตัวเอง หรืออยากคุยเล่น บอกหนูได้เลยนะคะ 😊\n(ถ้าช่วงนี้ไม่สะดวกให้หนูทัก พิมพ์ “พักก่อน” ได้เลยค่ะ หนูจะไม่รบกวนนะคะ)";
  return [pick(openers), favTxt, tail].filter(Boolean).join("\n");
}

// เลือก "รูปคะแนนสูง (รองๆ ลงมา)" จากคลัง — ไม่สุ่มทั่วไป ; เข้าหมวดที่ชอบก่อนถ้ามี
// การ์ดเช้าส่งอันดับ 1 ไปแล้ว → ตรงนี้สุ่มจาก top คะแนน "ข้ามอันดับ 1" เพื่อได้รูปดี ๆ ที่ไม่ซ้ำ
async function bestImage(favCat: string | null): Promise<string | null> {
  for (const folder of [thaiDateISO(), "evergreen"]) {
    try {
      const r = await fetch(`${BASE}/img/${folder}/manifest.json?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) continue;
      const m = await r.json();
      let imgs = (m?.images || [])
        .map((x: any) => (typeof x === "string"
          ? { file: x, score: 0, category: "" }
          : { file: x?.file, score: Number(x?.score) || 0, category: x?.category || "" }))
        .filter((x: any) => typeof x.file === "string" && x.file);
      if (!imgs.length) continue;
      if (favCat) {
        const inCat = imgs.filter((x: any) => x.category === favCat);
        if (inCat.length) imgs = inCat;             // มีหมวดที่ชอบ → ใช้หมวดนั้น
      }
      imgs.sort((a: any, b: any) => b.score - a.score);                 // คะแนนสูงสุดก่อน
      const top = imgs.slice(0, Math.min(12, imgs.length));             // เฉพาะกลุ่มคะแนนสูง
      const poolPick = top.length > 1 ? top.slice(1) : top;             // ข้ามอันดับ 1 (การ์ดเช้าส่งแล้ว)
      return `${BASE}/img/${folder}/${pick(poolPick).file}`;
    } catch { /* next */ }
  }
  return null;
}

async function pushTo(userId: string, messages: unknown[]): Promise<boolean> {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify({ to: userId, messages }),
    });
    return r.ok;
  } catch { return false; }
}

async function dueList(hour: number): Promise<{ user_id: string; name: string | null; fav_cat: string | null }[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/line_checkin_due`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ p_hour: hour, p_cooldown_hours: COOLDOWN_HOURS, p_default_hour: DEFAULT_HOUR, p_limit: MAX_PER_RUN }),
  });
  if (!r.ok) throw new Error(`due ${r.status} ${await r.text()}`);
  return await r.json();
}

async function markCheckedIn(userIds: string[]) {
  if (!userIds.length) return;
  const list = userIds.map((u) => `"${u}"`).join(",");
  await fetch(`${SUPABASE_URL}/rest/v1/line_friends?user_id=in.(${encodeURIComponent(list)})`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify({ last_checkin_at: new Date().toISOString() }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (CRON_KEY === "" || req.headers.get("x-cron-key") !== CRON_KEY) return json({ error: "unauthorized" }, 401);

  const hour = ictHour();
  let due: { user_id: string; name: string | null; fav_cat: string | null }[];
  try { due = await dueList(hour); } catch (e) { return json({ error: String(e) }, 500); }
  if (!due.length) return json({ hour, due: 0, sent: 0 });

  const sent: string[] = [];
  for (const u of due) {
    const name = cleanName(u.name);
    const msgs: unknown[] = [{ type: "text", text: greetText(name, u.fav_cat) }];
    const img = await bestImage(u.fav_cat);   // รูปคะแนนสูง (รองๆ ลงมา) — ส่งรูปดี ๆ ให้ทุกคน
    if (img) msgs.push({ type: "image", originalContentUrl: img, previewImageUrl: img });
    if (await pushTo(u.user_id, msgs)) sent.push(u.user_id);
    await sleep(120);
  }
  await markCheckedIn(sent);
  return json({ hour, due: due.length, sent: sent.length });
});
