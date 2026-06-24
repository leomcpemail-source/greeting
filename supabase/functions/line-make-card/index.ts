// supabase/functions/line-make-card/index.ts
// เอารูปของ user มาใส่คำอวยพร + กรอบประจำวัน (สีตามวัน) → อัปโหลด storage → push กลับทาง LINE (ไม่เก็บเข้าคลัง)
// เรียกจาก line-webhook ด้วย internal token ; ตอบ 200 เร็ว แล้ว render+push เบื้องหลัง (EdgeRuntime.waitUntil)
// รองรับคำอวยพร custom (body.bless) — ให้ user แก้ข้อความเองได้
//
// ENV: LINE_CHANNEL_ACCESS_TOKEN, MKCARD_TOKEN, (แพลตฟอร์มใส่ให้) SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// หมายเหตุ: Storage รับ service key (sb_secret) ทาง header `apikey` เท่านั้น

import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

// secrets: env (ถ้ามี) หรือ globalThis.__SEC ที่ loader ใส่ให้ (ดู DEPLOY.md)
const G = (globalThis as any).__SEC ?? {};
const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || G.AT || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || G.URL || "https://iuyiwpoupnuxnohpatyw.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || G.SK || "";
const INTERNAL_TOKEN = Deno.env.get("MKCARD_TOKEN") || G.MK || "";
const BUCKET = "usercards";
const BASE = "https://raw.githubusercontent.com/leomcpemail-source/greeting/daily-images";
const FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/Sarabun-Bold.ttf";

// ข้อความเตือนเมื่อรูปที่ส่งมา "มีตัวหนังสืออยู่แล้ว" (กันทำตัวอักษรซ้อนกันดูรก)
const WARN_TEXTED =
  "ขออภัยนะคะ 🙏 ภาพนี้มีข้อความอยู่แล้ว น้องใส่ใจเลยแก้ไขให้ไม่ได้ค่ะ (ของเดิมก็สวยอยู่แล้วน้า)\n" +
  "ถ้าอยากให้หนูช่วยใส่คำอวยพรดี ๆ ลองส่ง “รูปถ่ายที่ยังไม่มีตัวหนังสือ” มาได้เลยนะคะ เดี๋ยวหนูจัดให้สวย ๆ ค่ะ 💛";

const FALLBACK_BLESS = [
  "ขอให้วันนี้เป็นวันที่ดี สุขกายสบายใจนะคะ",
  "อรุณสวัสดิ์ ขอให้มีรอยยิ้มทั้งวันนะคะ",
  "ขอให้สุขภาพแข็งแรง คิดสิ่งใดสมหวังนะคะ",
];
const WD = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const MO = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
// สีประจำวัน (เข้ม, เข้มกว่า) ใช้เป็น fallback ถ้า manifest ไม่มี color
const DAY_COL = [["#e0322f", "#7d1715"], ["#f2b705", "#8a6800"], ["#e84f9c", "#7d2256"], ["#2faa5d", "#155c31"], ["#ef8a21", "#8a4a08"], ["#1f73c4", "#0f4677"], ["#7a4fc0", "#3d2569"]];
// สีกรอบที่ user เลือกเองได้ (key ตรงกับ parseFrameColor ใน line-webhook) — [สีกรอบ/ตัวอักษร, สีเข้มฮาโล/ขอบ]
const FRAME_COLORS: Record<string, [string, string]> = {
  "เทา": ["#9aa0a6", "#4a4f54"], "เทาเข้ม": ["#6b7178", "#2f3438"],
  "แดง": ["#e0322f", "#7d1715"], "ชมพู": ["#e84f9c", "#7d2256"], "ชมพูอ่อน": ["#f48fb1", "#9c3b62"],
  "ฟ้า": ["#29a3df", "#0f4677"], "น้ำเงิน": ["#2746b8", "#152663"], "เขียว": ["#2faa5d", "#155c31"],
  "เหลือง": ["#f2b705", "#8a6800"], "ส้ม": ["#ef8a21", "#8a4a08"], "ม่วง": ["#7a4fc0", "#3d2569"],
  "ทอง": ["#d4a017", "#7a5c00"], "เงิน": ["#b8bcc2", "#5c6066"], "น้ำตาล": ["#8d5524", "#4a2c12"],
  "ครีม": ["#d9c089", "#8a774a"], "ดำ": ["#2b2b2b", "#000000"], "ขาว": ["#ffffff", "#7a7f85"],
};
function applyFrame(day: any, frame: string) {
  if (frame === "รุ้ง") {            // กรอบไล่สีรุ้ง — ตัวอักษรใช้สีอ่านง่าย (ขาว + ขอบเข้ม)
    day.color = "#e23b6d"; day.color2 = "#2f2350"; day.frameGrad = "rainbow";
    return;
  }
  const f = FRAME_COLORS[frame];
  if (f) { day.color = f[0]; day.color2 = f[1]; day.frameGrad = ""; }
}

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
const isHex = (v: any) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);
// แก้ปัญหา resvg เรนเดอร์ "สระอำ" (ำ U+0E33) ซ้อนทับพยัญชนะ → แตกเป็น นิคหิต + สระอา ให้จัดตำแหน่งด้วย mark-positioning
function shapeThai(s: string): string {
  return String(s)
    .replace(/([่-๋])ำ/g, "ํ$1า") // (วรรณยุกต์)+อำ → นิคหิต+วรรณยุกต์+สระอา (เช่น น้ำ ค่ำ ซ้ำ)
    .replace(/ำ/g, "ํา");                   // อำ → นิคหิต+สระอา (เช่น กำ ทำ คำ จำ)
}
const tx = (s: string) => esc(shapeThai(s));
// ลายน้ำแบรนด์ (มุมบนกลาง — ตรงข้ามกับคำอวยพรที่อยู่ครึ่งล่างของการ์ด) จาง ~60%
function watermark(): string {
  const fs = 22, text = "น้องใส่ใจ · สวัสดีทุกวัน";
  const adv = [...text].filter((c) => !/[ัิ-ฺ็-๎]/.test(c)).length;
  const textW = Math.round(adv * fs * 0.6);
  const padL = 11, icon = 34, gap = 11, padR = 15, h = 48;
  const w = padL + icon + gap + textW + padR;
  const x = Math.round(500 - w / 2), y = 34, iy = y + (h - icon) / 2, ix = x + padL;
  return `<g opacity="0.6">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#000000" fill-opacity="0.34"/>
    <rect x="${ix}" y="${iy}" width="${icon}" height="${icon}" rx="${Math.round(icon * 0.28)}" fill="#06C755"/>
    <text x="${ix + icon / 2}" y="${iy + icon * 0.66}" font-family="Sarabun" font-weight="700" font-size="${Math.round(icon * 0.36)}" fill="#ffffff" text-anchor="middle">LINE</text>
    <text x="${x + padL + icon + gap}" y="${y + h / 2 + 8}" font-family="Sarabun" font-weight="700" font-size="${fs}" fill="#ffffff">${tx(text)}</text>
  </g>`;
}

async function loadDay() {
  const wd = ictNow().getUTCDay();
  const dc = DAY_COL[wd];
  for (const folder of [thaiDateISO(), "evergreen"]) {
    try {
      const r = await fetch(`${BASE}/img/${folder}/manifest.json?v=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const m = await r.json();
        return {
          headline: (m.headline || "").trim() || headlineToday(),
          bless: (Array.isArray(m.blessings) && m.blessings.length ? pick(m.blessings) : pick(FALLBACK_BLESS)),
          dateThai: (m.dateThai || "").trim() || dateThaiToday(),
          color: isHex(m.color) ? m.color : dc[0],
          color2: isHex(m.color2) ? m.color2 : dc[1],
        };
      }
    } catch (_e) { /* next */ }
  }
  return { headline: headlineToday(), bless: pick(FALLBACK_BLESS), dateThai: dateThaiToday(), color: dc[0], color2: dc[1] };
}

// ตัดคำอวยพรเป็นหลายบรรทัด (greedy ตามคำ) — คำเดี่ยวยาวเกินก็ตัดแข็ง กันล้นกรอบ
function wrapLines(t: string, maxChars: number): string[] {
  const words = String(t).trim().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
    while (cur.length > maxChars) { lines.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [String(t)];
}
// จัดวางคำอวยพรให้ "พอดีกรอบเสมอ" — เลือกขนาดฟอนต์อัตโนมัติให้ไม่ล้นทั้งแนวกว้างและแนวสูง
function layoutBless(text: string): { lines: string[]; F: number; lineGap: number; bandTop: number; bandH: number } {
  const MAXW = 860, bandTop = 782, bandBot = 916, bandH = bandBot - bandTop;
  for (let F = 42; ; F -= 2) {
    const maxChars = Math.max(8, Math.floor(MAXW / (F * 0.55)));
    const lines = wrapLines(text, maxChars);
    const lineGap = Math.round(F * 1.25);
    if (lines.length * lineGap <= bandH || F <= 22) return { lines, F, lineGap, bandTop, bandH };
  }
}

function buildSvg(photoDataUri: string, day: { headline: string; bless: string; dateThai: string; color: string; color2: string }) {
  const W = 1000, H = 1000;
  const col = day.color, col2 = day.color2;
  // กรอบไล่สีรุ้ง (ถ้าเลือก "สีรุ้ง") — กรอบใช้ gradient ส่วนตัวอักษรยังใช้สีทึบเพื่ออ่านง่าย
  const grad = (day as any).frameGrad === "rainbow";
  const frameStroke = grad ? "url(#framegrad)" : col;
  const gradDef = grad
    ? `<linearGradient id="framegrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff3b30"/><stop offset="0.18" stop-color="#ff9500"/>
        <stop offset="0.36" stop-color="#ffd60a"/><stop offset="0.54" stop-color="#34c759"/>
        <stop offset="0.72" stop-color="#0a84ff"/><stop offset="0.88" stop-color="#5e5ce6"/>
        <stop offset="1" stop-color="#bf5af2"/></linearGradient>`
    : "";
  const hl = day.headline;
  const hSize = hl.length <= 10 ? 104 : hl.length <= 14 ? 86 : 70;
  const hY = 760;
  // หัวข้อ: ฮาโลสีเข้มประจำวัน (อ่านง่าย) + ตัวขาวขอบสีประจำวัน
  const tA = `font-family="Sarabun" font-weight="700" font-size="${hSize}" text-anchor="middle" stroke-linejoin="round"`;
  const headline =
    `<text x="500" y="${hY}" ${tA} fill="none" stroke="${col2}" stroke-opacity="0.92" stroke-width="17" paint-order="stroke">${tx(hl)}</text>` +
    `<text x="500" y="${hY}" ${tA} fill="#ffffff" stroke="${col}" stroke-width="6" paint-order="stroke">${tx(hl)}</text>`;
  const bl = layoutBless(day.bless);
  const blTotal = bl.lines.length * bl.lineGap;
  let by = bl.bandTop + (bl.bandH - blTotal) / 2 + bl.F;   // baseline บรรทัดแรก (จัดกึ่งกลางแนวสูงในแถบ)
  const blStroke = Math.max(3, Math.round(bl.F * 0.15));
  const blessText = bl.lines.map((ln) => {
    const t = `<text x="500" y="${by.toFixed(0)}" font-family="Sarabun" font-weight="700" font-size="${bl.F}" fill="#ffffff" text-anchor="middle" stroke="${col2}" stroke-opacity="0.85" stroke-width="${blStroke}" paint-order="stroke">${tx(ln)}</text>`;
    by += bl.lineGap; return t;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.18"/>
        <stop offset="0.5" stop-color="#000" stop-opacity="0"/>
        <stop offset="0.62" stop-color="#000" stop-opacity="0.12"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.72"/>
      </linearGradient>
      ${gradDef}
    </defs>
    <rect width="${W}" height="${H}" fill="#222"/>
    <image href="${photoDataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>
    <rect width="${W}" height="${H}" fill="url(#scrim)"/>
    <rect x="22" y="22" width="${W - 44}" height="${H - 44}" fill="none" stroke="${frameStroke}" stroke-width="10" rx="28"/>
    <rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2.5" rx="20"/>
    ${headline}
    ${blessText}
    <text x="500" y="930" font-family="Sarabun" font-weight="700" font-size="26" fill="#ffffff" fill-opacity="0.95" text-anchor="middle" stroke="${col2}" stroke-opacity="0.7" stroke-width="3" paint-order="stroke">${tx(day.dateThai)}</text>
    ${watermark()}
  </svg>`;
}

async function renderCard(photo: Uint8Array, mime: string, day: any): Promise<Uint8Array> {
  await ensureWasm();
  const font = await loadFont();
  const dataUri = `data:${mime};base64,${encodeBase64(photo)}`;
  const resvg = new Resvg(buildSvg(dataUri, day), { font: { fontBuffers: [font], defaultFontFamily: "Sarabun", loadSystemFonts: false }, fitTo: { mode: "width", value: 1000 } });
  return resvg.render().asPng();
}

// อ่านขนาดภาพจาก header (JPEG/PNG) แบบเบา ๆ — ใช้เดาว่าน่าจะเป็น "การ์ดมีตัวหนังสือ" (รูปจัตุรัส 1:1)
function imageSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) { // PNG
    return { w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] };
  }
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) { // JPEG
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}
// รูปจัตุรัสเกือบเป๊ะ = น่าจะเป็นการ์ดของระบบ (มีตัวหนังสือแล้ว)
function looksLikeCard(b: Uint8Array): boolean {
  const s = imageSize(b);
  if (!s || s.w <= 0 || s.h <= 0) return false;
  return Math.abs(s.w / s.h - 1) <= 0.05;
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

async function job(userId: string, messageId: string, test: boolean, customBless: string, frame = "") {
  try {
    let photo: Uint8Array, mime: string;
    if (test) {
      const r = await fetch("https://picsum.photos/900");
      photo = new Uint8Array(await r.arrayBuffer()); mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    } else {
      const d = await downloadPhoto(messageId); photo = d.buf; mime = d.mime;
      if (looksLikeCard(photo)) { await push(userId, [{ type: "text", text: WARN_TEXTED }]); return; }
    }
    const day = await loadDay();
    if (customBless) day.bless = customBless;
    if (frame) applyFrame(day, frame);
    const png = await renderCard(photo, mime, day);
    const url = await uploadCard(png);
    const hint = customBless
      ? "แก้ให้เรียบร้อยแล้วค่ะ! 💛 ถ้าอยากเปลี่ยนคำอวยพรอีก พิมพ์ “แก้คำอวยพรเป็น …” หรืออยากเปลี่ยนสีกรอบ พิมพ์ “เปลี่ยนกรอบเป็นสี…” (เช่น สีฟ้า สีทอง) ได้เลยนะคะ ✨"
      : "เสร็จแล้วค่ะ! ✨ ภาพสวัสดีจากรูปของคุณ 🌸\nอยากได้คำอวยพรแบบไหนเป็นพิเศษ พิมพ์ “แก้คำอวยพรเป็น …” หรืออยากเปลี่ยนสีกรอบ พิมพ์ “เปลี่ยนกรอบเป็นสี…” (เช่น สีเทา สีฟ้า สีทอง) แล้วหนูจะทำให้ใหม่ทันทีเลยนะคะ 💛";
    await push(userId, [
      { type: "image", originalContentUrl: url, previewImageUrl: url },
      { type: "text", text: hint },
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
  if (body.preview) { // โหมดทดสอบเรนเดอร์ (ไม่ push LINE) — คืน URL รูปทันที เพื่อตรวจสระอำ
    const day = await loadDay();
    if (body.bless) day.bless = String(body.bless);
    if (body.headline) day.headline = String(body.headline);
    if (body.frame) applyFrame(day, String(body.frame));
    const rr = await fetch("https://picsum.photos/900");
    const png = await renderCard(new Uint8Array(await rr.arrayBuffer()), "image/jpeg", day);
    return new Response(JSON.stringify({ url: await uploadCard(png) }), { headers: { "Content-Type": "application/json" } });
  }
  const userId = String(body.userId || "");
  if (!userId) return new Response(JSON.stringify({ error: "no userId" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const p = job(userId, String(body.messageId || ""), !!body.test, String(body.bless || "").slice(0, 120), String(body.frame || ""));
  // @ts-ignore EdgeRuntime มีบน Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p); else await p;
  return new Response(JSON.stringify({ accepted: true }), { headers: { "Content-Type": "application/json" } });
});
