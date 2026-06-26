// supabase/functions/line-visit/index.ts
// บันทึก "ที่มาของผู้เยี่ยมชมเว็บ" จาก IP → geo (เก็บแค่ประเทศ/จังหวัด/เมือง — ไม่เก็บเลข IP ดิบ = privacy)
// เรียกจาก index.html ตอนเปิดเว็บ (fire-and-forget) ; lookup เฉพาะผู้เยี่ยมชม "ใหม่" เพื่อประหยัด external call
// auth: เปิดสาธารณะ (ผู้เยี่ยมชมทั่วไปเรียกได้) — เก็บข้อมูลผ่าน RPC web_visit_log ด้วย service key
//
// ENV: (แพลตฟอร์มใส่ให้) SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const G = (globalThis as any).__SEC ?? {};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || G.URL || "https://iuyiwpoupnuxnohpatyw.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || G.SK || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return (xff.split(",")[0].trim()) || req.headers.get("x-real-ip") || "";
}

async function alreadyKnown(vid: string): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/web_visits?visitor_id=eq.${encodeURIComponent(vid)}&select=visitor_id`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    return r.ok ? (await r.json()).length > 0 : false;
  } catch { return false; }
}

async function geoLookup(ip: string): Promise<{ country: string; cc: string; region: string; city: string }> {
  const empty = { country: "", cc: "", region: "", city: "" };
  if (!ip) return empty;
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const g = await r.json();
      if (g && g.success) return { country: g.country || "", cc: g.country_code || "", region: g.region || "", city: g.city || "" };
    }
  } catch { /* fail-soft */ }
  return empty;
}

async function logVisit(vid: string, g: { country: string; cc: string; region: string; city: string }) {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/web_visit_log`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ p_vid: vid, p_country: g.country, p_cc: g.cc, p_region: g.region, p_city: g.city }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const vid = String(body.visitor_id || "").slice(0, 64).replace(/[^\w.\-]/g, "");
  if (!vid) return json({ error: "no visitor" }, 400);

  // lookup geo เฉพาะผู้เยี่ยมชมใหม่ ; ผู้เยี่ยมชมเดิม = แค่ bump last_seen/visits (ไม่ยิง external ซ้ำ)
  let g = { country: "", cc: "", region: "", city: "" };
  if (!(await alreadyKnown(vid))) g = await geoLookup(clientIp(req));
  await logVisit(vid, g);
  return json({ ok: true });
});
