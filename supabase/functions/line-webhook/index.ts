// supabase/functions/line-webhook/index.ts
// Webhook ของ LINE Official Account — รับเหตุการณ์จาก LINE แล้วเก็บ "เพื่อน" ลงตาราง line_friends
//   • follow   = มีคนกดเพิ่มเพื่อน  → บันทึก userId (active=true) + ตอบข้อความต้อนรับ
//   • unfollow = มีคนบล็อก/ลบเพื่อน → ตั้ง active=false (จะได้ไม่ส่งตอนเช้า)
//   • message  = พิมพ์อะไรมาก็ตอบสั้น ๆ ว่าจะส่งคำอวยพรให้ทุกเช้า
// ตัวส่งตอนเช้า (06:00) อยู่ที่ GitHub Actions: scripts/line_morning.mjs — อ่านรายชื่อจากตารางนี้
//
// ENV ที่ต้องตั้งเป็น secret ของ Edge Function:
//   LINE_CHANNEL_SECRET        — เอาไว้ตรวจลายเซ็น x-line-signature
//   LINE_CHANNEL_ACCESS_TOKEN  — เอาไว้ตอบข้อความ + ดึงชื่อโปรไฟล์
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY แพลตฟอร์มใส่ให้อัตโนมัติ)
//
// ตอน deploy ต้องปิดการเช็ค JWT (LINE ไม่ได้แนบ JWT มา):
//   supabase functions deploy line-webhook --no-verify-jwt

const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const WELCOME_TEXT =
  "ขอบคุณที่เพิ่มเป็นเพื่อนกันนะคะ 🌸\n" +
  "ทุกเช้า 6 โมง เราจะส่งรูปสวัสดีพร้อมคำอวยพรดี ๆ มาให้ทุกวันเลยค่ะ ☀️\n" +
  "ขอให้เป็นวันที่ดีนะคะ 💛";

// ── ตรวจลายเซ็น: HMAC-SHA256(rawBody, channelSecret) เข้ารหัส base64 ต้องตรงกับ x-line-signature ──
async function verifySignature(rawBody: string, signature: string): Promise<boolean> {
  if (!CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // เทียบแบบ length-safe (ไม่ใช่ timing-safe เป๊ะ แต่พอสำหรับงานนี้)
  return expected === signature;
}

// ── เรียก LINE API ──
async function lineReply(replyToken: string, text: string) {
  if (!ACCESS_TOKEN) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  }).catch(() => {});
}

async function lineProfileName(userId: string): Promise<string | null> {
  if (!ACCESS_TOKEN) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.displayName ?? null;
  } catch {
    return null;
  }
}

// ── เขียนลงตาราง line_friends ผ่าน PostgREST (ใช้ service role → ข้าม RLS) ──
async function upsertFriend(userId: string, displayName: string | null) {
  await fetch(`${SUPABASE_URL}/rest/v1/line_friends`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      display_name: displayName,
      active: true,
      followed_at: new Date().toISOString(),
      unfollowed_at: null,
    }),
  }).catch(() => {});
}

async function deactivateFriend(userId: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/line_friends?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ active: false, unfollowed_at: new Date().toISOString() }),
    },
  ).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  if (!(await verifySignature(rawBody, signature))) {
    return new Response("bad signature", { status: 401 });
  }

  let payload: { events?: any[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // ทำงานให้เสร็จก่อนตอบ 200 (จำนวน event ต่อรอบไม่มาก)
  for (const ev of payload.events ?? []) {
    const userId = ev?.source?.userId as string | undefined;
    try {
      if (ev.type === "follow" && userId) {
        const name = await lineProfileName(userId);
        await upsertFriend(userId, name);
        if (ev.replyToken) await lineReply(ev.replyToken, WELCOME_TEXT);
      } else if (ev.type === "unfollow" && userId) {
        await deactivateFriend(userId);
      } else if (ev.type === "message" && ev.replyToken) {
        await lineReply(
          ev.replyToken,
          "รับทราบค่า 😊 ทุกเช้า 6 โมงเราจะส่งรูปสวัสดีพร้อมคำอวยพรมาให้นะคะ ☀️",
        );
      }
    } catch (_e) {
      // ไม่ให้ event เดียวล้มทั้งรอบ — LINE ต้องได้ 200 เสมอ
    }
  }

  return new Response("ok", { status: 200 });
});
