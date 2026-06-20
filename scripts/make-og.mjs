// make-og.mjs — สร้างรูปพรีวิวลิงก์ (Open Graph) assets/og-cover.jpg 1200x630
// ใช้ตอนแชร์ลิงก์เข้า LINE/โซเชียล ให้ขึ้นพรีวิวสวย ๆ (Loma-Bold + shapeThai)
// รัน: npm i @resvg/resvg-js sharp  แล้ว  node scripts/make-og.mjs
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import fs from "node:fs";

const W = 1200, H = 630;
const FONT_PATH = "/usr/share/fonts/opentype/tlwg/Loma-Bold.otf";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shapeThai = (s) => String(s).replace(/([่-๋])ำ/g, "ํ$1า").replace(/ำ/g, "ํา");
const tx = (s) => esc(shapeThai(s));

function sun(cx, cy, r) {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    rays += `<line x1="${(cx + Math.cos(a) * (r + 16)).toFixed(1)}" y1="${(cy + Math.sin(a) * (r + 16)).toFixed(1)}" x2="${(cx + Math.cos(a) * (r + 42)).toFixed(1)}" y2="${(cy + Math.sin(a) * (r + 42)).toFixed(1)}" stroke="#F39C12" stroke-width="11" stroke-linecap="round"/>`;
  }
  return `${rays}<circle cx="${cx}" cy="${cy}" r="${r}" fill="#F7C948"/>`;
}
const T = (x, y, size, t, fill, anchor = "middle") =>
  `<text x="${x}" y="${y}" font-family="Loma" font-weight="700" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${tx(t)}</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#EAF3FB"/><stop offset="1" stop-color="#FDF6EA"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="38" fill="none" stroke="#CBD9E8" stroke-width="3"/>
  ${sun(600, 170, 70)}
  ${T(600, 360, 104, "สวัสดีทุกวัน", "#33475B")}
  ${T(600, 440, 42, "ภาพสวย คำอวยพรดี ๆ ส่งต่อความสุข", "#5a6b7d")}
  ${T(600, 520, 34, "ทุกเช้ามีรูปสวัสดีใหม่ให้เลือกส่งทุกวัน", "#8a98a8")}
</svg>`;

const font = fs.readFileSync(FONT_PATH);
const resvg = new Resvg(svg, { font: { fontBuffers: [font], defaultFontFamily: "Loma", loadSystemFonts: false }, fitTo: { mode: "original" } });
const jpg = await sharp(resvg.render().asPng()).jpeg({ quality: 88 }).toBuffer();
fs.writeFileSync(new URL("../assets/og-cover.jpg", import.meta.url), jpg);
console.log("✓ wrote assets/og-cover.jpg", jpg.length, "bytes");
