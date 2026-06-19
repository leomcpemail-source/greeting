// supabase/functions/line-make-card/index.ts
// เอารูปของ user มาใส่คำอวยพร + กรอบประจำวัน → อัปโหลด storage → push กลับทาง LINE (ไม่เก็บเข้าคลัง)
// เรียกจาก line-webhook ด้วย internal token ; ตอบ 200 เร็ว แล้ว render+push เบื้องหลัง (EdgeRuntime.waitUntil)
// render ตัวอักษรไทย + กรอบด้วย resvg-wasm (ไม่ต้องใช้เบราว์เซอร์)
//
// ENV: LINE_CHANNEL_ACCESS_TOKEN, MKCARD_TOKEN, (แพลตฟอร์มใส่ให้) SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// หมายเหตุ: Storage รับ service key (sb_secret) ทาง header `apikey` เท่านั้น (ไม่ใช่ Authorization Bearer)

import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_TOKEN = Deno.env.get("MKCARD_TOKEN") ?? "";
const BUCKET = "usercards";
const BASE = "https://raw.githubusercontent.com/leomcpemail-source/greeting/daily-images";
const FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/Sarabun-Bold.ttf";

const FALLBACK_BLESS = [
  "ขอให้วันนี้เป็นวันที่ดี สุขกายสบายใจนะคะ",
  "อรุณสวัสดิ์ ขอให้มีรอยยิ้มทั้งวันนะคะ",
  "ขอให้สุขภาพแข็งแรง คิดสิ่งใดสมหวังนะคะ",
];
const WD = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const MO = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

let _wasm: Promise<void> | null = null;
function ensureWasm() { if (!_wasm) _wasm = initWasm(fetch("https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm")); return _wasm; }
let _font: Uint8Array | null = null;
async function loadFont() { if (_font) return _font; const r = await fetch(FONT_URL); if (!r.ok) throw new Error("font " + r.status); _font = new Uint8Array(await r.arrayBuffer()); return _font; }

function ictNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
function thaiDateISO() { const d = ictNow(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }
function headlineToday() { return `สวัสดีวัน${WD[ictNow().getUTCDay()]}`; }
function dateThaiToday() { const d = ictNow(); return `วัน${WD[d.getUTCDay()]}ที่ ${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`; }
const pick = (a: any[]) => a[Math.floor(Math.random() * a.length)];
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function loadDay() {
  for (const folder of [thaiDateISO(), "evergreen"]) {
    try {
      const r = await fetch(`${BASE}/img/${folder}/manifest.json?v=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const m = await r.json();
        return {
          headline: (m.headline || "").trim() || headlineToday(),
          bless: (Array.isArray(m.blessings) && m.blessings.length ? pick(m.blessings) : pick(FALLBACK_BLESS)),
          dateThai: (m.dateThai || "").trim() || dateThaiToday(),
        };
      }
    } catch (_e) { /* next */ }
  }
  return { headline: headlineToday(), bless: pick(FALLBACK_BLESS), dateThai: dateThaiToday() };
}

function wrap2(t: string, maxLen: number): string[] {
  if (t.length <= maxLen) return [t];
  const parts = t.split(" ");
  if (parts.length < 2) return [t.slice(0, maxLen), t.slice(maxLen)];
  let l1 = "", i = 0;
  for (; i < parts.length; i++) { if ((l1 + " " + parts[i]).trim().length > maxLen && l1) break; l1 = (l1 + " " + parts[i]).trim(); }
  const l2 = parts.slice(i).join(" ");
  return l2 ? [l1, l2] : [l1];
}

function buildSvg(photoDataUri: string, day: { headline: string; bless: string; dateThai: string }) {
  const W = 1000, H = 1000;
  const hl = day.headline;
  const hSize = hl.length <= 10 ? 104 : hl.length <= 14 ? 86 : 70;
  const blLines = wrap2(day.bless, 30);
  let by = 855 - (blLines.length - 1) * 26;
  const blessText = blLines.map((ln) => {
    const t = `<text x="500" y="${by}" font-family="Sarabun" font-weight="700" font-size="40" fill="#fff7e6" text-anchor="middle" stroke="#000" stroke-opacity="0.55" stroke-width="3" paint-order="stroke">${esc(ln)}</text>`;
    by += 52; return t;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.18"/>
        <stop offset="0.5" stop-color="#000" stop-opacity="0"/>
        <stop offset="0.62" stop-color="#000" stop-opacity="0.12"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.72"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="#222"/>
    <image href="${photoDataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>
    <rect width="${W}" height="${H}" fill="url(#scrim)"/>
    <rect x="22" y="22" width="${W - 44}" height="${H - 44}" fill="none" stroke="#e7c46a" stroke-width="8" rx="28"/>
    <rect x="38" y="38" width="${W - 76}" height="${H - 76}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2.5" rx="20"/>
    <text x="500" y="760" font-family="Sarabun" font-weight="700" font-size="${hSize}" fill="#ffffff" text-anchor="middle" stroke="#000" stroke-opacity="0.6" stroke-width="6" paint-order="stroke">${esc(hl)}</text>
    ${blessText}
    <text x="500" y="930" font-family="Sarabun" font-weight="700" font-size="26" fill="#ffffff" fill-opacity="0.92" text-anchor="middle" stroke="#000" stroke-opacity="0.4" stroke-width="2" paint-order="stroke">${esc(day.dateThai)}</text>
  </svg>`;
}

async function renderCard(photo: Uint8Array, mime: string, day: any): Promise<Uint8Array> {
  await ensureWasm();
  const font = await loadFont();
  const dataUri = `data:${mime};base64,${encodeBase64(photo)}`;
  const resvg = new Resvg(buildSvg(dataUri, day), { font: { fontBuffers: [font], defaultFontFamily: "Sarabun", loadSystemFonts: false }, fitTo: { mode: "width", value: 1000 } });
  return resvg.render().asPng();
}

async function downloadPhoto(messageId: string): Promise<{ buf: Uint8Array; mime: string }> {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error("content " + r.status);
  const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  return { buf: new Uint8Array(await r.arrayBuffer()), mime };
}

async function uploadCard(png: Uint8Array): Promise<string> {
  const path = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "image/png", "x-upsert": "true" },
    body: png,
  });
  if (!r.ok) throw new Error("upload " + r.status + " " + await r.text());
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function push(userId: string, messages: unknown[]) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ to: userId, messages }),
  }).catch(() => {});
}

async function job(userId: string, messageId: string, test: boolean) {
  try {
    let photo: Uint8Array, mime: string;
    if (test) {
      const r = await fetch("https://picsum.photos/900");
      photo = new Uint8Array(await r.arrayBuffer()); mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    } else {
      const d = await downloadPhoto(messageId); photo = d.buf; mime = d.mime;
    }
    const day = await loadDay();
    const png = await renderCard(photo, mime, day);
    const url = await uploadCard(png);
    await push(userId, [
      { type: "image", originalContentUrl: url, previewImageUrl: url },
      { type: "text", text: `เสร็จแล้วค่ะ! ✨ ภาพสวัสดีจากรูปของคุณ 🌸\nกดค้างที่รูปเพื่อบันทึกหรือส่งต่อให้คนที่คุณรักได้เลยนะคะ 💛` },
    ]);
  } catch (e) {
    await push(userId, [{ type: "text", text: "ขอโทษนะคะ น้องใส่ใจทำภาพไม่สำเร็จนิดหนึ่ง ลองส่งรูปใหม่อีกครั้งได้ไหมคะ 🙏" }]).catch(() => {});
    console.error("make-card error", String(e));
  }
}

Deno.serve(async (req) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  if (body.token !== INTERNAL_TOKEN) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  const userId = String(body.userId || "");
  if (!userId) return new Response(JSON.stringify({ error: "no userId" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const p = job(userId, String(body.messageId || ""), !!body.test);
  // @ts-ignore EdgeRuntime มีบน Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p); else await p;
  return new Response(JSON.stringify({ accepted: true }), { headers: { "Content-Type": "application/json" } });
});
