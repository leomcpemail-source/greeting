// Supabase Edge Function: "manifest"
// ----------------------------------------------------------------------------
// ทำหน้าที่เป็น "ประตู" (origin gate) สำหรับดึงไฟล์ manifest/index ของเว็บ greeting
//
// แนวคิด: เว็บจริงเรียก function นี้เพื่อขอ manifest แทนการยิงไป raw.githubusercontent
// ตรง ๆ  ฝั่ง server จะเช็ค Origin header ของคำขอ:
//   • มาจากโดเมนจริง  -> ดึงไฟล์จริงจาก raw ส่งกลับให้
//   • มาจากโดเมนอื่น (เว็บที่ clone ไป deploy ที่อื่น) -> ส่ง {} เปล่า ๆ แบบเงียบ ๆ
//     ทำให้หน้าเว็บของคนที่ลอกไป "ว่าง ไม่มีรูป" โดยไม่มี error ชัดเจนในคอนโซล
//
// เหตุที่กันแบบ "หาไม่เจอ" ได้: logic การตัดสินใจอยู่ฝั่ง server ทั้งหมด
// โค้ดฝั่ง client (index.html) ดูปกติทุกอย่าง — แค่ fetch URL หนึ่งที่บังเอิญ
// คืนค่าว่างให้เฉพาะคนที่ไม่ได้อยู่บนโดเมนจริง

const REPO = "leomcpemail-source/greeting";
const BRANCH = "daily-images";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

// โดเมนจริงที่อนุญาต (เทียบ Origin แบบเป๊ะ ๆ)
const ALLOW_EXACT = new Set<string>([
  "https://leomcpemail-source.github.io",
]);

function originAllowed(origin: string): boolean {
  if (!origin) return false;
  if (ALLOW_EXACT.has(origin)) return true;
  // เผื่อรันบนเครื่องตอน dev (localhost / 127.0.0.1 ทุกพอร์ต)
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
  } catch (_) { /* origin เพี้ยน -> ถือว่าไม่ผ่าน */ }
  return false;
}

// อนุญาตเฉพาะ path ที่เป็นไฟล์ manifest/index เท่านั้น (กันถูกใช้เป็น open proxy)
function pathAllowed(p: string): boolean {
  return /^img\/[A-Za-z0-9_-]+\/manifest\.json$/.test(p)
      || /^img\/cat_bank\/index\.json$/.test(p);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin") || "";
  // echo origin กลับเสมอ เพื่อไม่ให้เกิด CORS error ชัด ๆ ในฝั่งคนที่ลอกไป
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Vary": "Origin",
  };
  const json = (body: string, status: number) =>
    new Response(body, {
      status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const path = new URL(req.url).searchParams.get("path") || "";

  // origin ไม่ผ่าน หรือ path ผิดรูป -> ตอบว่างแบบเงียบ (200 {} ไม่ใช่ error)
  if (!originAllowed(origin) || !pathAllowed(path)) return json("{}", 200);

  // origin ผ่าน -> ดึงไฟล์จริงจาก raw ฝั่ง server แล้วส่งต่อ
  const r = await fetch(`${RAW}/${path}`, { cache: "no-store" }).catch(() => null);
  // ไฟล์ยังไม่มีจริง (เช่น manifest ของวันนี้ยังไม่ถูก gen) -> ตอบ 404
  // เพื่อให้ client fallback ไป evergreen เองได้ตามเดิม
  if (!r || !r.ok) return json("{}", 404);

  return json(await r.text(), 200);
});
