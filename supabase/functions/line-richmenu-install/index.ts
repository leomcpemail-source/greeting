// line-richmenu-install — ติดตั้ง Rich Menu 2 ระดับเข้า LINE OA
//   • เมนูหลัก (greeting-main)       ขนาด 2500x843  (2 ปุ่มใหญ่: หน้าแรก / ตามหมวด)
//   • เมนูหมวด (greeting-categories) ขนาด 2500x1686 (เต็มจอ — ปุ่มใหญ่ อ่าน/กดง่าย สำหรับผู้สูงอายุ)
//   • ดึงรูปจาก repo (assets/richmenu/*.jpg) → resize อัตโนมัติ (ImageScript) → อัปโหลด + alias + ตั้ง default
//   • เรียกซ้ำเพื่ออัปเดตได้ (ลบของเดิมก่อน) ; กันเรียกมั่วด้วย header x-cron-key
//
// ENV: LINE_CHANNEL_ACCESS_TOKEN, CRON_KEY, (ออปชัน) APP_URL, RICHMENU_RAW_BASE
//
// โครงเมนู:
//   เมนูหลัก: ซ้าย "หน้าแรก" → เว็บแอพ | ขวา "ตามหมวด" → สลับเมนูย่อย
//   เมนูหมวด: แถบบน "‹ กลับ" → สลับกลับ + กริด 4×3 (12 หมวด) → เว็บแอพ ?cat=<id>

import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

const ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const CRON_KEY = Deno.env.get("CRON_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://leomcpemail-source.github.io/greeting/";
const RAW = Deno.env.get("RICHMENU_RAW_BASE") ??
  "https://raw.githubusercontent.com/leomcpemail-source/greeting/main/assets/richmenu";
const IMG_MAIN = `${RAW}/main.jpg`;
const IMG_CATS = `${RAW}/categories.jpg`;

const W = 2500;
const H_MAIN = 843;   // เมนูหลักครึ่งจอ
const H_CATS = 1686;  // เมนูหมวดเต็มจอ
const ALIAS_MAIN = "greeting-main";
const ALIAS_CATS = "greeting-categories";
const API = "https://api.line.me";
const API_DATA = "https://api-data.line.me";
const authH = () => ({ Authorization: `Bearer ${ACCESS_TOKEN}` });

// 12 หมวด (ลำดับตรงกับรูป categories.jpg และ CATEGORIES ใน index.html)
const CATS = [
  "flowers", "dharma", "inspire", "miss",
  "birthday", "elderly", "health", "festival",
  "family", "pets", "coffee", "nature",
];

const mainAreas = [
  { bounds: { x: 0, y: 0, width: 1250, height: H_MAIN }, action: { type: "uri", uri: APP_URL } },
  { bounds: { x: 1250, y: 0, width: 1250, height: H_MAIN }, action: { type: "richmenuswitch", richMenuAliasId: ALIAS_CATS, data: "to=categories" } },
];

function catAreas() {
  // สัดส่วนเดียวกับรูป: header ~11% บนสุด, 3 แถวเท่ากัน (186 + 3×500 = 1686)
  const BACK_H = 186, cols = 4, colW = 625, rowH = 500;
  const areas: unknown[] = [
    { bounds: { x: 0, y: 0, width: W, height: BACK_H }, action: { type: "richmenuswitch", richMenuAliasId: ALIAS_MAIN, data: "to=main" } },
  ];
  CATS.forEach((id, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = col * colW, y = BACK_H + row * rowH;
    const width = col === cols - 1 ? W - x : colW;
    const height = row === 2 ? H_CATS - y : rowH;
    areas.push({ bounds: { x, y, width, height }, action: { type: "uri", uri: `${APP_URL}?cat=${id}` } });
  });
  return areas;
}

async function fetchResized(url: string, h: number): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch image ${url} ${r.status}`);
  const img = await Image.decode(new Uint8Array(await r.arrayBuffer()));
  img.resize(W, h);
  return await img.encodeJPEG(85);
}

async function lineJson(method: string, p: string, body?: unknown) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...authH(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : {};
}

async function uploadImage(richMenuId: string, bytes: Uint8Array) {
  const r = await fetch(`${API_DATA}/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { ...authH(), "Content-Type": "image/jpeg" },
    body: bytes,
  });
  if (!r.ok) throw new Error(`upload ${richMenuId} ${r.status} ${await r.text()}`);
}

async function cleanup() {
  for (const a of [ALIAS_MAIN, ALIAS_CATS]) {
    await fetch(`${API}/v2/bot/richmenu/alias/${a}`, { method: "DELETE", headers: authH() }).catch(() => {});
  }
  try {
    const list = await lineJson("GET", "/v2/bot/richmenu/list");
    for (const rm of list.richmenus || []) {
      await fetch(`${API}/v2/bot/richmenu/${rm.richMenuId}`, { method: "DELETE", headers: authH() }).catch(() => {});
    }
  } catch { /* ignore */ }
}

async function createMenu(name: string, chatBarText: string, areas: unknown[], bytes: Uint8Array, h: number) {
  const { richMenuId } = await lineJson("POST", "/v2/bot/richmenu", {
    size: { width: W, height: h }, selected: true, name, chatBarText, areas,
  });
  await uploadImage(richMenuId, bytes);
  return richMenuId as string;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-key") !== CRON_KEY) return new Response("unauthorized", { status: 401 });
  try {
    const [mainImg, catsImg] = await Promise.all([fetchResized(IMG_MAIN, H_MAIN), fetchResized(IMG_CATS, H_CATS)]);
    await cleanup();
    const idMain = await createMenu("greeting main", "เมนู ☰", mainAreas, mainImg, H_MAIN);
    const idCats = await createMenu("greeting categories", "เลือกหมวด ☰", catAreas(), catsImg, H_CATS);
    await lineJson("POST", "/v2/bot/richmenu/alias", { richMenuAliasId: ALIAS_MAIN, richMenuId: idMain });
    await lineJson("POST", "/v2/bot/richmenu/alias", { richMenuAliasId: ALIAS_CATS, richMenuId: idCats });
    await lineJson("POST", `/v2/bot/user/all/richmenu/${idMain}`);
    return new Response(JSON.stringify({ ok: true, idMain, idCats, mainSize: `${W}x${H_MAIN}`, catsSize: `${W}x${H_CATS}` }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
