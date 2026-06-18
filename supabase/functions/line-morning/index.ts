// supabase/functions/line-morning/index.ts
// ส่งรูปอวยพรประจำวัน + ข้อความ ไปหาเพื่อนทีละคนทุกเช้า
// ถูกเรียกโดย pg_cron (ผ่าน pg_net) ทุกวัน 23:00 UTC = 06:00 น. (เวลาไทย)
// ป้องกันการเรียกมั่วด้วย header x-cron-key
//
// อ่านเพื่อนจากตาราง line_friends ผ่าน service role (แพลตฟอร์มใส่ ENV ให้อัตโนมัติ)
// รูปหยิบจาก manifest ของวัน (branch daily-images) ; ไม่มีก็ fallback evergreen
//
// ENV (ตั้งเป็น secret ของ Edge Function):
//   LINE_CHANNEL_ACCESS_TOKEN  — โทเคน Messaging API
//   CRON_KEY                   — รหัสกันเรียกมั่ว (ต้องตรงกับที่ pg_cron ส่งมาใน header x-cron-key)
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY แพลตฟอร์มใส่ให้อัตโนมัติ)
//
// ตั้งเวลา (รันใน SQL editor ของโปรเจกต์ ดู supabase/cron/line_morning_schedule.sql)

const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const CRON_KEY = Deno.env.get("CRON_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const REPO = "leomcpemail-source/greeting";
const BRANCH = "daily-images";
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const FALLBACK_BLESS = [
  "ขอให้วันนี้เป็นวันที่ดี สุขกายสบายใจนะคะ",
  "อรุณสวัสดิ์ ขอให้รอยยิ้มอยู่กับคุณทั้งวันค่ะ",
  "ขอให้สุขภาพแข็งแรง คิดสิ่งใดสมหวังนะคะ",
  "ส่งความสุขและกำลังใจดี ๆ ให้ในยามเช้าค่ะ",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

function thaiDateISO(): string {
  const ict = new Date(Date.now() + 7 * 3600 * 1000);
  const y = ict.getUTCFullYear();
  const m = String(ict.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ict.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function fetchManifest(folder: string): Promise<any | null> {
  try {
    const r = await fetch(`${BASE}/img/${folder}/manifest.json?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function pickTodayCard(): Promise<{ folder: string; image: any } | null> {
  for (const folder of [thaiDateISO(), "evergreen"]) {
    const m = await fetchManifest(folder);
    const imgs = (m?.images || []).filter((x: any) => x && (typeof x === "string" ? x : x.file));
    if (imgs.length) {
      const raw = pick(imgs);
      return { folder, image: typeof raw === "string" ? { file: raw } : raw };
    }
  }
  return null;
}

function composeText(image: any): string {
  const headline = (image.headline || "").trim();
  const bless = (image.blessing || "").trim() || pick(FALLBACK_BLESS);
  const head = headline ? `☀️ ${headline}` : "☀️ อรุณสวัสดิ์";
  return `${head}\n${bless}\n\nขอให้เป็นวันที่ดีนะคะ 🌸`;
}

async function getActiveFriends(): Promise<string[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/line_friends?active=eq.true&select=user_id`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`load friends ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows.map((x: any) => x.user_id).filter(Boolean);
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
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ last_sent_at: new Date().toISOString() }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-key") !== CRON_KEY) {
    return new Response("unauthorized", { status: 401 });
  }

  const card = await pickTodayCard();
  if (!card) return new Response(JSON.stringify({ error: "no images" }), { status: 200 });

  const imageUrl = `${BASE}/img/${card.folder}/${card.image.file}`;
  const messages = [
    { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
    { type: "text", text: composeText(card.image) },
  ];

  const friends = await getActiveFriends();
  let ok = 0;
  const sent: string[] = [];
  const failed: { userId: string; status?: number }[] = [];
  for (const userId of friends) {
    const res = await pushToFriend(userId, messages);
    if (res.ok) { ok++; sent.push(userId); } else { failed.push({ userId, status: res.status }); }
    await sleep(200);
  }
  await markSent(sent);

  return new Response(
    JSON.stringify({ folder: card.folder, image: card.image.file, total: friends.length, ok, failed: failed.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
