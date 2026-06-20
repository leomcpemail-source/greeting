// supabase/functions/line-go/index.ts
// บันทึกคลิกจาก LINE → เว็บ แล้ว redirect ไปเว็บแอป (วัด click-through จาก rich menu / ข้อความเช้า)
// ใช้งาน: GET /line-go?c=<cat>&s=<source>  →  302 → APP_URL(?cat=<cat>)
// fail-open: ถ้า log ไม่ได้ก็ยัง redirect ต่อ (ไม่ทำให้ลิงก์พัง)
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, (ออปชัน) APP_URL

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://leomcpemail-source.github.io/greeting/";

// หมวดที่อนุญาต (กันยัด query แปลก ๆ)
const CATS = new Set([
  "flowers", "dharma", "inspire", "miss", "birthday", "elderly",
  "health", "festival", "family", "pets", "coffee", "nature",
]);

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const catRaw = (u.searchParams.get("c") || "").toLowerCase().replace(/[^a-z]/g, "");
  const cat = CATS.has(catRaw) ? catRaw : "";
  const src = (u.searchParams.get("s") || "").replace(/[^a-z0-9_]/gi, "").slice(0, 24);

  // ปลายทางภายนอกที่อนุญาต (กัน open-redirect) — เว็บในเครือเดียวกันเท่านั้น เช่น AI โสเหล่
  const ALLOW_HOSTS = new Set(["leomcpemail-source.github.io"]);
  let dest = APP_URL;
  const toRaw = u.searchParams.get("to") || "";
  if (toRaw) {
    try { const t = new URL(toRaw); if (ALLOW_HOSTS.has(t.hostname)) dest = t.toString(); } catch { /* ignore bad url */ }
  } else if (cat) {
    dest += (APP_URL.includes("?") ? "&" : "?") + "cat=" + encodeURIComponent(cat);
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/line_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ kind: "click", source: src || null, cat: cat || null }),
    });
  } catch (_e) { /* fail-open */ }

  return new Response(null, { status: 302, headers: { Location: dest, "Cache-Control": "no-store" } });
});
