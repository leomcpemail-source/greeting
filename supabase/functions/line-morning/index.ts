// supabase/functions/line-morning/index.ts
// ส่งทุกเช้า 06:00 น. — สลับรูปแบบไปมากันกันเบื่อ (รูปล้วน ↔ การ์ด Flex) + ทักชื่อรายคน + ปุ่มแชร์
// หลักการ: ขึ้นต้นด้วย "รูป" เสมอ (ฟอร์เวิร์ด/เซฟ/แชร์ง่าย) แล้วสลับรูปแบบการส่งไปมากันกันเบื่อ
// ถูกเรียกโดย pg_cron (ผ่าน pg_net) 23:00 UTC = 06:00 น.(ไทย) ; กันเรียกมั่วด้วย header x-cron-key
// ทดสอบ: เติม ?style=cards หรือ ?style=images เพื่อบังคับรูปแบบ ; ?dry=1 ดู payload โดยไม่ส่งจริง
//
// ENV: LINE_CHANNEL_ACCESS_TOKEN, CRON_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, (ออปชัน) APP_URL, CARDS_PER_DAY

const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const CRON_KEY = Deno.env.get("CRON_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://leomcpemail-source.github.io/greeting/";
const CARDS_PER_DAY = Number(Deno.env.get("CARDS_PER_DAY") ?? "5");

const REPO = "leomcpemail-source/greeting";
const BRANCH = "daily-images";
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

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

// ทำชื่อโปรไฟล์ให้สะอาด: ตัดวงเล็บ (...), ตัดอีโมจิ, จำกัดความยาว
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

// เลือกรูปไม่ซ้ำ n ใบ (เอาของวันนี้ก่อน ไม่พอค่อยเติมด้วย evergreen)
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
        { type: "button", style: "link", height: "sm", action: { type: "uri", label: "ดูรูปอื่น ๆ", uri: APP_URL } },
      ] },
    };
  });
  return {
    type: "flex",
    altText: (name ? `การ์ดอวยพรเช้านี้สำหรับคุณ ${name} 🌸` : `การ์ดอวยพรเช้านี้ 🌸`).slice(0, 390),
    contents: { type: "carousel", contents: bubbles },
  };
}

// สร้างชุดข้อความตามสไตล์ของวัน (ขึ้นต้นด้วยรูปเสมอ เพื่อแชร์ง่าย) ; จำกัด ≤ 5 บับเบิล/ครั้ง
function buildMessages(cards: { folder: string; file: string }[], name: string, style: "images" | "cards") {
  if (style === "cards") {
    const lead = cards[0];
    const rest = cards.slice(1);
    return [introMsg(name, "cards"), imageMsg(lead), buildCarousel(rest.length ? rest : cards, name)];
  }
  // images: ข้อความทักทาย + รูปใหญ่เต็มจอสูงสุด 4 รูป (รวม 5 บับเบิล)
  return [introMsg(name, "images"), ...cards.slice(0, 4).map(imageMsg)];
}

async function getActiveFriends(): Promise<{ user_id: string; display_name: string | null }[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/line_friends?active=eq.true&select=user_id,display_name`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`load friends ${r.status} ${await r.text()}`);
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
  if (req.headers.get("x-cron-key") !== CRON_KEY) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const force = url.searchParams.get("style");
  const dry = url.searchParams.get("dry") === "1";

  // สลับสไตล์ไปมากันกันวันคู่/วันคี่ (ไม่ซ้ำสองวันติด)
  const style: "images" | "cards" = force === "cards" || force === "images"
    ? force
    : (dayIndex() % 2 === 0 ? "images" : "cards");

  const cards = await pickCards(CARDS_PER_DAY);
  if (!cards.length) return new Response(JSON.stringify({ error: "no images" }), { status: 200 });

  if (dry) {
    const sample = buildMessages(cards, "ตัวอย่าง", style);
    return new Response(JSON.stringify({ style, cards: cards.length, messages: sample }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const friends = await getActiveFriends();
  let ok = 0;
  const sent: string[] = [];
  const failed: { userId: string; status?: number; body?: string }[] = [];
  for (const f of friends) {
    const name = cleanName(f.display_name);
    const res = await pushToFriend(f.user_id, buildMessages(cards, name, style));
    if (res.ok) { ok++; sent.push(f.user_id); } else { failed.push({ userId: f.user_id, status: res.status, body: res.body }); }
    await sleep(200);
  }
  await markSent(sent);

  return new Response(
    JSON.stringify({ style, cards: cards.length, total: friends.length, ok, failed }),
    { headers: { "Content-Type": "application/json" } },
  );
});
