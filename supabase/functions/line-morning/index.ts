// supabase/functions/line-morning/index.ts
// ส่งทุกเช้า 06:00 น. — สลับรูปแบบไปมากันกันเบื่อ (รูปล้วน ↔ การ์ด Flex) + ทักชื่อรายคน + ปุ่มแชร์
// auth: cron (header x-cron-key) หรือ admin (?token=) จาก db.html
// ยิงรายคน: ?to=<userId> (โหมดทดสอบ ไม่อัปเดต last_sent_at) ; ?style=cards|images ; ?dry=1 ดู payload
// ลิงก์ "ดูรูปอื่น" วิ่งผ่าน line-go เพื่อเก็บ click-through
//
// ENV: LINE_CHANNEL_ACCESS_TOKEN, CRON_KEY, DASH_ADMIN_TOKEN, SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY, (ออปชัน) APP_URL, CARDS_PER_DAY

// secrets: รับจาก env ถ้าตั้งไว้ ไม่งั้นจาก globalThis.__SEC ที่ตัว loader ใส่ให้ (ไม่ฝัง secret ในรีโป)
const G = (globalThis as any).__SEC ?? {};
const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || G.AT || "";
const CRON_KEY = Deno.env.get("CRON_KEY") || G.CRON || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || G.URL || "https://iuyiwpoupnuxnohpatyw.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || G.SK || "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://leomcpemail-source.github.io/greeting/";

const REPO = "leomcpemail-source/greeting";
const BRANCH = "daily-images";
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ictNow(): Date { return new Date(Date.now() + 7 * 3600 * 1000); }
function thaiDateISO(): string {
  const d = ictNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function cleanName(dn: string | null): string {
  if (!dn) return "";
  let n = dn.replace(/\([^)]*\)/g, " ");
  n = n.replace(/[\p{Extended_Pictographic}‍️]/gu, "");
  n = n.replace(/\s+/g, " ").trim();
  if (n.length > 20) n = n.slice(0, 20).trim();
  return n;
}

async function fetchManifest(folder: string): Promise<any | null> {
  try {
    const r = await fetch(`${BASE}/img/${folder}/manifest.json?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// เลือก "ภาพคะแนนสูงสุด" ของวัน (ส่งวันละ 1 ภาพ) — วันนี้ก่อน ถ้าไม่มีค่อยใช้ evergreen
async function pickBest(): Promise<{ folder: string; file: string } | null> {
  for (const folder of [thaiDateISO(), "evergreen"]) {
    const m = await fetchManifest(folder);
    const imgs = (m?.images || [])
      .map((x: any) => (typeof x === "string" ? { file: x, score: 0 } : { file: x?.file, score: Number(x?.score) || 0 }))
      .filter((x: any) => typeof x.file === "string" && x.file);
    if (imgs.length) {
      imgs.sort((a: any, b: any) => b.score - a.score);   // คะแนนสูงสุดมาก่อน
      return { folder, file: imgs[0].file };
    }
  }
  return null;
}

const urlOf = (c: { folder: string; file: string }) => `${BASE}/img/${c.folder}/${c.file}`;
const imageMsg = (c: { folder: string; file: string }) => ({ type: "image", originalContentUrl: urlOf(c), previewImageUrl: urlOf(c) });

function introMsg(name: string) {
  const hi = name ? `☀️ อรุณสวัสดิ์ค่ะ คุณ ${name} 🌸` : "☀️ อรุณสวัสดิ์ค่ะ 🌸";
  // ส่งเป็น "รูปจริง" → อยากส่งต่อให้เพื่อนเป็นรูป ให้กดค้างที่รูปแล้วเลือก "ส่งต่อ" (ไม่ใช่ปุ่มแชร์ที่ได้เป็นลิงก์)
  const tail = "วันนี้มีการ์ดอวยพรมาฝากค่ะ 🌸\nอยากส่งให้เพื่อน — กดค้างที่รูป 👉 เลือก “ส่งต่อ” ได้เลย จะส่งเป็นรูปสวย ๆ ให้เพื่อนทันทีค่ะ 💛";
  return { type: "text", text: `${hi}\n${tail}` };
}

// ส่งวันละ 1 ภาพ (คะแนนสูงสุด) — เป็น image message forward เป็น "รูปจริง" ได้
function buildMessages(card: { folder: string; file: string }, name: string) {
  return [introMsg(name), imageMsg(card)];
}

async function getActiveFriends(): Promise<{ user_id: string; display_name: string | null }[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/line_friends?active=eq.true&select=user_id,display_name`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`load friends ${r.status} ${await r.text()}`);
  return await r.json();
}

async function getFriendById(uid: string): Promise<{ user_id: string; display_name: string | null }[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/line_friends?user_id=eq.${encodeURIComponent(uid)}&select=user_id,display_name`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`load friend ${r.status} ${await r.text()}`);
  return await r.json();
}

async function pushToFriend(userId: string, messages: unknown[]) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ to: userId, messages }),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, body: await r.text().catch(() => "") };
}

async function markSent(userIds: string[]) {
  if (!userIds.length) return;
  const list = userIds.map((u) => `"${u}"`).join(",");
  await fetch(`${SUPABASE_URL}/rest/v1/line_friends?user_id=in.(${encodeURIComponent(list)})`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify({ last_sent_at: new Date().toISOString() }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const isCron = CRON_KEY !== "" && req.headers.get("x-cron-key") === CRON_KEY;
  // admin = session token จาก db.html (ออกหลังยืนยัน TOTP) → ตรวจกับตาราง line_admin_sessions
  let isAdmin = false;
  if (!isCron && token) {
    try {
      const sr = await fetch(`${SUPABASE_URL}/rest/v1/line_admin_sessions?token=eq.${encodeURIComponent(token)}&select=expires_at`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
      if (sr.ok) { const rows = await sr.json(); isAdmin = !!(rows[0] && new Date(rows[0].expires_at).getTime() > Date.now()); }
    } catch { /* ignore */ }
  }
  if (!isCron && !isAdmin) return json({ error: "unauthorized" }, 401);

  const dry = url.searchParams.get("dry") === "1";
  const to = url.searchParams.get("to");   // ยิงรายคน (โหมดทดสอบ)
  // broadcast (ไม่มี to = ส่งทุกคน) อนุญาตเฉพาะ cron เท่านั้น — admin token ส่งได้แค่รายคน (กันสแปมหากโทเค็นหลุด)
  if (!to && !isCron) return json({ error: "broadcast_requires_cron" }, 403);

  // ส่งวันละ 1 ภาพ = "ภาพคะแนนสูงสุด" ของวัน (ไม่สุ่ม)
  const best = await pickBest();
  if (!best) return json({ error: "no images" });

  if (dry) return json({ best, messages: buildMessages(best, "ตัวอย่าง") });

  let friends: { user_id: string; display_name: string | null }[];
  if (to) {
    friends = await getFriendById(to);
    if (!friends.length) return json({ error: "friend_not_found" }, 404);
  } else {
    friends = await getActiveFriends();
  }

  let ok = 0;
  const sent: string[] = [];
  const failed: { userId: string; status?: number; body?: string }[] = [];
  for (const f of friends) {
    const name = cleanName(f.display_name);
    const res = await pushToFriend(f.user_id, buildMessages(best, name));
    if (res.ok) { ok++; sent.push(f.user_id); } else { failed.push({ userId: f.user_id, status: res.status, body: res.body }); }
    await sleep(150);
  }
  // โหมดทดสอบรายคน (to) ไม่อัปเดต last_sent_at — สถิติ "ส่งถึงวันนี้" จะไม่รวมการทดสอบ
  if (!to) await markSent(sent);

  return json({ image: best.file, total: friends.length, ok, failed, test: !!to });
});
