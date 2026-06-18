// supabase/functions/line-morning/index.ts
// ส่งทุกเช้า 06:00 น. — สลับรูปแบบไปมากันกันเบื่อ (รูปล้วน ↔ การ์ด Flex) + ทักชื่อรายคน + ปุ่มแชร์
// auth: cron (header x-cron-key) หรือ admin (?token=) จาก db.html
// ยิงรายคน: ?to=<userId> (โหมดทดสอบ ไม่อัปเดต last_sent_at) ; ?style=cards|images ; ?dry=1 ดู payload
// ลิงก์ "ดูรูปอื่น" วิ่งผ่าน line-go เพื่อเก็บ click-through
//
// ENV: LINE_CHANNEL_ACCESS_TOKEN, CRON_KEY, DASH_ADMIN_TOKEN, SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY, (ออปชัน) APP_URL, CARDS_PER_DAY

const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const CRON_KEY = Deno.env.get("CRON_KEY") ?? "";
const ADMIN_TOKEN = Deno.env.get("DASH_ADMIN_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://leomcpemail-source.github.io/greeting/";
const CARDS_PER_DAY = Number(Deno.env.get("CARDS_PER_DAY") ?? "5");
const GO = `${SUPABASE_URL}/functions/v1/line-go`;

const REPO = "leomcpemail-source/greeting";
const BRANCH = "daily-images";
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

const WD = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const FALLBACK_BLESS = [
  "ขอให้วันนี้เป็นวันที่ดี สุขกายสบายใจนะคะ",
  "อรุณสวัสดิ์ ขอให้รอยยิ้มอยู่กับคุณทั้งวันค่ะ",
  "ขอให้สุขภาพแข็งแรง คิดสิ่งใดสมหวังนะคะ",
  "ส่งความสุขและกำลังใจดี ๆ ให้ในยามเช้าค่ะ",
  "ขอให้โชคดีเข้าหาตลอดทั้งวันนะคะ",
  "สุขภาพแข็งแรง ร่างกายสดชื่น ใจเบิกบานทุกวันค่ะ",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function ictNow(): Date { return new Date(Date.now() + 7 * 3600 * 1000); }
function thaiDateISO(): string {
  const d = ictNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function headlineToday(): string { return `สวัสดีวัน${WD[ictNow().getUTCDay()]}`; }
function dayIndex(): number { const d = ictNow(); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000); }

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

async function pickCards(n: number): Promise<{ folder: string; file: string }[]> {
  const out: { folder: string; file: string }[] = [];
  const seen = new Set<string>();
  for (const folder of [thaiDateISO(), "evergreen"]) {
    const m = await fetchManifest(folder);
    let imgs = (m?.images || [])
      .map((x: any) => (typeof x === "string" ? x : x?.file))
      .filter((f: any) => typeof f === "string" && f);
    imgs = shuffle(imgs);
    for (const f of imgs) {
      if (out.length >= n) break;
      const key = `${folder}/${f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ folder, file: f });
    }
    if (out.length >= n) break;
  }
  return out;
}

const urlOf = (c: { folder: string; file: string }) => `${BASE}/img/${c.folder}/${c.file}`;
const imageMsg = (c: { folder: string; file: string }) => ({ type: "image", originalContentUrl: urlOf(c), previewImageUrl: urlOf(c) });
const shareUrl = (text: string) => `https://line.me/R/share?text=${encodeURIComponent(text)}`;

function introMsg(name: string, style: "images" | "cards") {
  const hi = name ? `☀️ อรุณสวัสดิ์ค่ะ คุณ ${name} 🌸` : "☀️ อรุณสวัสดิ์ค่ะ 🌸";
  const tail = style === "cards"
    ? "วันนี้มีการ์ดอวยพรมาฝาก ปัดดูได้เลย ชอบใบไหนกด “ส่งต่อให้เพื่อน” ได้เลยนะคะ 💌"
    : "วันนี้มีรูปสวย ๆ มาฝาก กดค้างไว้แล้วส่งต่อให้คนที่คุณรักได้เลยนะคะ 💛";
  return { type: "text", text: `${hi}\n${tail}` };
}

function buildCarousel(cards: { folder: string; file: string }[], name: string) {
  const headline = headlineToday();
  const blesses = shuffle([...FALLBACK_BLESS]);
  const bubbles = cards.map((c, i) => {
    const imageUrl = urlOf(c);
    const bless = blesses[i % blesses.length];
    const sUrl = shareUrl(`☀️ ${headline}\n${bless}\n${imageUrl}`);
    return {
      type: "bubble",
      hero: { type: "image", url: imageUrl, size: "full", aspectRatio: "1:1", aspectMode: "cover", action: { type: "uri", uri: imageUrl } },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: `☀️ ${headline}`, weight: "bold", size: "md", color: "#2e8fd1", wrap: true },
        { type: "text", text: bless, size: "sm", color: "#243a4d", wrap: true },
      ] },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "button", style: "primary", color: "#06c755", height: "sm", action: { type: "uri", label: "ส่งต่อให้เพื่อน 💌", uri: sUrl } },
        { type: "button", style: "link", height: "sm", action: { type: "uri", label: "ดูรูปอื่น ๆ", uri: `${GO}?s=morning_more` } },
      ] },
    };
  });
  return {
    type: "flex",
    altText: (name ? `การ์ดอวยพรเช้านี้สำหรับคุณ ${name} 🌸` : `การ์ดอวยพรเช้านี้ 🌸`).slice(0, 390),
    contents: { type: "carousel", contents: bubbles },
  };
}

function buildMessages(cards: { folder: string; file: string }[], name: string, style: "images" | "cards") {
  if (style === "cards") {
    const lead = cards[0];
    const rest = cards.slice(1);
    return [introMsg(name, "cards"), imageMsg(lead), buildCarousel(rest.length ? rest : cards, name)];
  }
  return [introMsg(name, "images"), ...cards.slice(0, 4).map(imageMsg)];
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
  const authed = req.headers.get("x-cron-key") === CRON_KEY || (token && token === ADMIN_TOKEN);
  if (!authed) return json({ error: "unauthorized" }, 401);

  const force = url.searchParams.get("style");
  const dry = url.searchParams.get("dry") === "1";
  const to = url.searchParams.get("to");   // ยิงรายคน (โหมดทดสอบ)

  const style: "images" | "cards" = force === "cards" || force === "images"
    ? force
    : (dayIndex() % 2 === 0 ? "images" : "cards");

  const cards = await pickCards(CARDS_PER_DAY);
  if (!cards.length) return json({ error: "no images" });

  if (dry) return json({ style, cards: cards.length, messages: buildMessages(cards, "ตัวอย่าง", style) });

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
    const res = await pushToFriend(f.user_id, buildMessages(cards, name, style));
    if (res.ok) { ok++; sent.push(f.user_id); } else { failed.push({ userId: f.user_id, status: res.status, body: res.body }); }
    await sleep(150);
  }
  // โหมดทดสอบรายคน (to) ไม่อัปเดต last_sent_at — สถิติ "ส่งถึงวันนี้" จะไม่รวมการทดสอบ
  if (!to) await markSent(sent);

  return json({ style, cards: cards.length, total: friends.length, ok, failed, test: !!to });
});
