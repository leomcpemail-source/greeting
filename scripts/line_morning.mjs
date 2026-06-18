// scripts/line_morning.mjs
// ส่งคำอวยพรประจำวันเข้า LINE ทุกเช้า 06:00 (เวลาไทย) — รันโดย GitHub Actions (.github/workflows/line-morning.yml)
//
// ขั้นตอน:
//   1) หา manifest ของ "วันนี้" (ตามเวลาไทย) จาก branch daily-images ; ไม่มีก็ fallback เป็น evergreen
//   2) สุ่มรูปการ์ดอวยพร 1 ใบ (รูปนี้ baked ข้อความเสร็จแล้ว) + ดึงคำอวยพร/หัวข้อ
//   3) อ่านรายชื่อเพื่อนที่ active จาก Supabase (ตาราง line_friends)
//   4) ยิง push หาเพื่อน "ทีละคน" = รูป + ข้อความ ; เว้นจังหวะเล็กน้อยกันชน rate limit
//   5) อัปเดต last_sent_at (best-effort)
//
// ENV ที่ต้องมี (ตั้งเป็น GitHub Secrets):
//   LINE_CHANNEL_ACCESS_TOKEN  — โทเคนของ Messaging API channel
//   SUPABASE_URL               — เช่น https://xxxx.supabase.co (ของโปรเจกต์ที่เก็บ line_friends)
//   SUPABASE_SERVICE_ROLE_KEY  — service role key (อ่านตาราง line_friends ข้าม RLS)

const REPO = "leomcpemail-source/greeting";
const BRANCH = "daily-images";
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// คำอวยพรสำรอง เผื่อ manifest ไม่มี blessing (เช่น โฟลเดอร์ evergreen)
const FALLBACK_BLESS = [
  "ขอให้วันนี้เป็นวันที่ดี สุขกายสบายใจนะคะ",
  "อรุณสวัสดิ์ ขอให้รอยยิ้มอยู่กับคุณทั้งวันค่ะ",
  "ขอให้สุขภาพแข็งแรง คิดสิ่งใดสมหวังนะคะ",
  "ส่งความสุขและกำลังใจดี ๆ ให้ในยามเช้าค่ะ",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// วันที่ตามเวลาไทย (UTC+7) รูปแบบ YYYY-MM-DD
function thaiDateISO() {
  const ict = new Date(Date.now() + 7 * 3600 * 1000);
  const y = ict.getUTCFullYear();
  const m = String(ict.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ict.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function fetchManifest(folder) {
  const url = `${BASE}/img/${folder}/manifest.json?v=${Date.now()}`;
  const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

// คืน { folder, image } โดย image = หนึ่งรายการใน images[]
async function pickTodayCard() {
  const today = thaiDateISO();
  for (const folder of [today, "evergreen"]) {
    const m = await fetchManifest(folder);
    const imgs = (m?.images || []).filter((x) => x && (typeof x === "string" ? x : x.file));
    if (imgs.length) {
      const raw = pick(imgs);
      const image = typeof raw === "string" ? { file: raw } : raw;
      return { folder, image };
    }
  }
  return null;
}

function composeText(image) {
  const headline = (image.headline || "").trim();
  const bless = (image.blessing || "").trim() || pick(FALLBACK_BLESS);
  const head = headline ? `☀️ ${headline}` : "☀️ อรุณสวัสดิ์";
  return `${head}\n${bless}\n\nขอให้เป็นวันที่ดีนะคะ 🌸`;
}

async function getActiveFriends() {
  const url = `${SB_URL}/rest/v1/line_friends?active=eq.true&select=user_id`;
  const r = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`โหลดรายชื่อเพื่อนไม่สำเร็จ: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows.map((x) => x.user_id).filter(Boolean);
}

async function pushToFriend(userId, messages) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: userId, messages }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return { ok: false, status: r.status, body };
  }
  return { ok: true };
}

async function markSent(userIds) {
  if (!userIds.length) return;
  // PATCH แบบ in.(...) อัปเดต last_sent_at ทีเดียว
  const list = userIds.map((u) => `"${u}"`).join(",");
  const url = `${SB_URL}/rest/v1/line_friends?user_id=in.(${encodeURIComponent(list)})`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ last_sent_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function main() {
  if (!LINE_TOKEN || !SB_URL || !SB_KEY) {
    console.error("ขาด ENV: ต้องมี LINE_CHANNEL_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const card = await pickTodayCard();
  if (!card) {
    console.error("ไม่พบรูปใน manifest ทั้งของวันนี้และ evergreen — ยกเลิกการส่ง");
    process.exit(1);
  }
  const imageUrl = `${BASE}/img/${card.folder}/${card.image.file}`;
  const text = composeText(card.image);
  const messages = [
    { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
    { type: "text", text },
  ];
  console.log(`รูปของวันนี้ (${card.folder}): ${imageUrl}`);

  const friends = await getActiveFriends();
  console.log(`มีเพื่อน active ${friends.length} คน`);
  if (!friends.length) {
    console.log("ยังไม่มีเพื่อน — จบการทำงาน");
    return;
  }

  let ok = 0;
  const sent = [];
  const failed = [];
  for (const userId of friends) {
    const res = await pushToFriend(userId, messages);
    if (res.ok) {
      ok++;
      sent.push(userId);
    } else {
      failed.push({ userId, status: res.status });
      console.warn(`ส่งไม่สำเร็จ ${userId}: ${res.status} ${res.body || ""}`);
    }
    await sleep(250); // เว้นจังหวะกัน rate limit
  }

  await markSent(sent);
  console.log(`เสร็จสิ้น: ส่งสำเร็จ ${ok}/${friends.length} คน, ล้มเหลว ${failed.length}`);
  // ส่งบางคนไม่ได้ไม่ถือว่า workflow fail (เช่น เพื่อนบางคนบล็อก)
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
