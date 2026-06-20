// make-richmenu.mjs — สร้างรูป Rich Menu หลัก (assets/richmenu/main.jpg) ให้ตัวอักษรไทยถูกต้อง
// แก้ปัญหา "สระอำ (ำ) ซ้อน" บนปุ่ม "ทำภาพสวัสดี" ด้วย shapeThai (เหมือน line-make-card)
//
// รัน: npm i @resvg/resvg-js sharp  แล้ว  node scripts/make-richmenu.mjs
// (เมนู 3 ปุ่ม 2500x1686 : หน้าแรก | ตามหมวด | ส่งรูปของคุณ ทำภาพสวัสดี)
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import fs from "node:fs";

const W = 2500, H = 1686, COL = W / 3;
// ใช้ Loma-Bold (TLWG) — เรนเดอร์ตรง อ้วนหนา ตัวตั้งตรง (Sarabun ผ่าน resvg-js ออกมาเอียง)
const FONT_PATH = "/usr/share/fonts/opentype/tlwg/Loma-Bold.otf";
const FAM = "Loma";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// resvg ไม่จัดตำแหน่ง mark ของไทย → สระอำซ้อน : แตก ำ เป็น นิคหิต+สระอา (รองรับเคสมีวรรณยุกต์)
const shapeThai = (s) => String(s).replace(/([่-๋])ำ/g, "ํ$1า").replace(/ำ/g, "ํา");
const tx = (s) => esc(shapeThai(s));

async function loadFont() {
  return fs.readFileSync(FONT_PATH);
}

// ── ไอคอนแบบเวกเตอร์ (วาดเอง คมชัดทุกขนาด) ──
function sunIcon(cx, cy) {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * 150, y1 = cy + Math.sin(a) * 150;
    const x2 = cx + Math.cos(a) * 220, y2 = cy + Math.sin(a) * 220;
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#F39C12" stroke-width="26" stroke-linecap="round"/>`;
  }
  return `${rays}<circle cx="${cx}" cy="${cy}" r="120" fill="#F7C948"/>`;
}
function gridIcon(cx, cy) {
  const s = 150, g = 40, o = s + g / 2;
  const sq = (dx, dy) => `<rect x="${cx + dx - s / 2}" y="${cy + dy - s / 2}" width="${s}" height="${s}" rx="26" fill="#4A90D9"/>`;
  return sq(-o / 1, -o / 1) + sq(o / 1, -o / 1) + sq(-o / 1, o / 1) + sq(o / 1, o / 1);
}
function cameraIcon(cx, cy) {
  return `
    <rect x="${cx - 100}" y="${cy - 150}" width="120" height="56" rx="18" fill="#4F9A60"/>
    <rect x="${cx - 185}" y="${cy - 110}" width="370" height="250" rx="46" fill="#5BA86B"/>
    <circle cx="${cx}" cy="${cy + 18}" r="92" fill="#E8F2E3"/>
    <circle cx="${cx}" cy="${cy + 18}" r="52" fill="#4F9A60"/>
    <circle cx="${cx + 120}" cy="${cy - 70}" r="16" fill="#ffffff"/>`;
}

function panel(i, bg) {
  const x = i * COL + 22, y = 22, w = COL - 44, h = H - 44;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="48" fill="${bg}"/>`;
}
function label(cx, y, size, text, color, weight = 700) {
  return `<text x="${cx}" y="${y}" font-family="${FAM}" font-weight="${weight}" font-size="${size}" fill="${color}" text-anchor="middle">${tx(text)}</text>`;
}

function buildSvg() {
  const c0 = COL * 0.5, c1 = COL * 1.5, c2 = COL * 2.5;
  const NAVY = "#33475B", GREY = "#9aa6b2";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    ${panel(0, "#E4F0FA")}${panel(1, "#F8EFDD")}${panel(2, "#E3EFDD")}
    <g>${sunIcon(c0, 560)}</g>
    <g>${gridIcon(c1, 560)}</g>
    <g>${cameraIcon(c2, 560)}</g>
    ${label(c0, 1110, 120, "หน้าแรก", NAVY)}
    ${label(c0, 1250, 62, "ดูรูปล่าสุด", GREY)}
    ${label(c1, 1110, 120, "ตามหมวด", NAVY)}
    ${label(c1, 1250, 60, "12 หมวดให้เลือก", GREY)}
    ${label(c2, 1075, 98, "ส่งรูปของคุณ", NAVY)}
    ${label(c2, 1215, 98, "ทำภาพสวัสดี", NAVY)}
  </svg>`;
}

const font = await loadFont();
const resvg = new Resvg(buildSvg(), { font: { fontBuffers: [font], defaultFontFamily: FAM, loadSystemFonts: false }, fitTo: { mode: "original" } });
const png = resvg.render().asPng();
const jpg = await sharp(png).jpeg({ quality: 90 }).toBuffer();
fs.writeFileSync(new URL("../assets/richmenu/main.jpg", import.meta.url), jpg);
console.log("✓ wrote assets/richmenu/main.jpg", jpg.length, "bytes");
