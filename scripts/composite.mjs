// scripts/composite.mjs
// ประกอบ "ภาพการ์ดจริง" (รูป + scrim + กรอบ + ข้อความ) แบบเดียวกับที่เบราว์เซอร์ทำ
// โดยดึงโค้ดเรนเดอร์ชุดเดียวกับ index.html มาใช้ใน headless browser (Puppeteer)
// → AI จะได้ตรวจ "สิ่งที่ user เห็นจริง" ไม่ใช่แค่รูปดิบ
//
// ออกแบบให้ "กันพัง": ถ้า extract/launch/render ล้มเหลว ผู้เรียกจับ error แล้ว
// fallback กลับไปตรวจรูปดิบแบบเดิมได้ทันที (ดู COMPOSITE_SCORING ใน generate.mjs)

import fs from 'node:fs';

/* ── ตัวตัดบล็อกโค้ดแบบรู้จัก string/template/comment (กัน brace ใน string พัง) ── */
function sliceBalanced(src, startIdx, open, close) {
  const i = src.indexOf(open, startIdx);
  if (i < 0) return null;
  let depth = 0;
  for (let p = i; p < src.length; p++) {
    const c = src[p], n = src[p + 1];
    if (c === '/' && n === '/') { p = src.indexOf('\n', p); if (p < 0) break; continue; }
    if (c === '/' && n === '*') { p = src.indexOf('*/', p + 2); if (p < 0) break; p++; continue; }
    if (c === "'" || c === '"' || c === '`') {           // ข้าม string/template ทั้งก้อน
      const q = c;
      for (p++; p < src.length; p++) {
        if (src[p] === '\\') { p++; continue; }
        if (src[p] === q) break;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(i, p + 1); }
  }
  return null;
}

// ดึง `const NAME = [ ... ];`
function extractConstArray(src, name) {
  const at = src.indexOf(`const ${name}=`);
  const at2 = at < 0 ? src.indexOf(`const ${name} =`) : at;
  if (at2 < 0) throw new Error(`extract: ไม่พบ const ${name}`);
  const body = sliceBalanced(src, at2, '[', ']');
  if (!body) throw new Error(`extract: ปิดวงเล็บ ${name} ไม่ครบ`);
  return `const ${name}=${body};`;
}

// ดึง `function NAME(...) { ... }`
function extractFunction(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`extract: ไม่พบ function ${name}`);
  const body = sliceBalanced(src, at, '{', '}');
  if (!body) throw new Error(`extract: ปิดปีกกา ${name} ไม่ครบ`);
  const header = src.slice(at, src.indexOf('{', at));
  return `${header}${body}`;
}

// ดึงบรรทัด `const fNum=...;`
function extractFNum(src) {
  const m = src.match(/const fNum\s*=\s*\([^)]*\)\s*=>\s*\{[^\n]*\};/);
  if (!m) throw new Error('extract: ไม่พบ const fNum');
  return m[0];
}

/* ── รวมโค้ดเรนเดอร์ทั้งหมดจาก index.html (แหล่งความจริงเดียว ไม่มี drift) ── */
export function extractRenderCode(indexHtmlPath) {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/i) || html.match(/<script>([\s\S]*)<\/script>/i);
  const js = m ? m[1] : html;
  return [
    extractConstArray(js, 'FRAMES'),
    extractConstArray(js, 'LAYOUTS'),
    extractConstArray(js, 'TEXT_SIZES'),
    extractConstArray(js, 'OVERLAYS'),
    extractFunction(js, 'hexA'),
    extractFunction(js, 'scrimCSS'),
    extractFNum(js),
    extractFunction(js, 'buildCorners'),
    extractFunction(js, 'applyFrameToCard'),
    extractFunction(js, 'buildCard'),
  ].join('\n\n');
}

/* ── สร้างหน้า harness สำหรับ headless render ── */
export function buildHarnessHtml(renderCode) {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Chonburi&family=Charm:wght@700&family=Sarabun:wght@400;600;700&family=Kanit:wght@600&family=Mitr:wght@500;600&family=Prompt:wght@600&family=Pridi:wght@500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#000}
  .cw{position:relative}
  .card{position:relative;overflow:hidden;border-radius:20px}
  .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
  .scrim{position:absolute;inset:0;z-index:1}
  .content{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;color:#fff}
  .hello{line-height:1.12;text-shadow:0 2px 12px rgba(0,0,0,.55)}
  .bless{font-family:'Charm',serif;font-weight:700;line-height:1.4;text-shadow:0 1px 8px rgba(0,0,0,.6)}
  .date{font-family:'Sarabun',sans-serif;font-size:13px;opacity:.92;margin-top:4px;text-shadow:0 1px 6px rgba(0,0,0,.6)}
  .sparkle{position:absolute;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.85);z-index:2}
</style></head><body>
<div id="stage"></div>
<script>
/* ===== โค้ดเรนเดอร์ชุดเดียวกับ index.html (ดึงมาอัตโนมัติ) ===== */
${renderCode}
/* ============================================================= */
let M={}, BASE='';
window.composeCard = async (opts) => {
  const { imgDataUrl, frameIdx, layoutIdx, txIdx, ovIdx, headline, blessing, dateThai, color, color2, dayTh, size, vp } = opts;
  M = { color, color2, headline, dayTh, dateThai, version:'x', images:[], blessings:[] };
  BASE = '';
  const combo = {
    imgSrc: imgDataUrl, imgIdx: 0,
    fr: FRAMES[frameIdx], lay: LAYOUTS[layoutIdx],
    bl: blessing, tx: TEXT_SIZES[txIdx], ov: OVERLAYS[ovIdx]
  };
  if (vp) combo.vp = vp;   // ตำแหน่งข้อความที่วิเคราะห์จากภาพ (บน/ล่าง)
  const stage = document.getElementById('stage');
  stage.innerHTML = '';
  const cw = buildCard(combo, size || 800);
  stage.appendChild(cw);
  const card = cw.querySelector('.card');
  // รอฟอนต์ + รูปโหลด ก่อนจับภาพ (สำคัญมาก ไม่งั้นตัวอักษร/รูปเพี้ยน)
  try { await document.fonts.ready; } catch(e){}
  const img = card.querySelector('img.bg');
  if (img && !img.complete) await new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 8000); });
  const canvas = await html2canvas(card, { scale: 1, useCORS: true, backgroundColor: null, logging: false });
  return canvas.toDataURL('image/jpeg', 0.85);
};
window.__harnessReady = true;
</script></body></html>`;
}

/* ── ตัวเรนเดอร์ headless (Puppeteer) ── */
export class CompositeRenderer {
  constructor(indexHtmlPath) { this.indexHtmlPath = indexHtmlPath; this.browser = null; this.page = null; }

  async init() {
    const renderCode = extractRenderCode(this.indexHtmlPath); // โยน error ถ้า extract ไม่ได้
    const puppeteer = (await import('puppeteer')).default;     // โยน error ถ้าไม่มี puppeteer
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    await this.page.setContent(buildHarnessHtml(renderCode), { waitUntil: 'networkidle0', timeout: 60000 });
    await this.page.waitForFunction('window.__harnessReady === true', { timeout: 30000 });
  }

  // คืน Buffer (jpeg) ของภาพการ์ดที่ประกอบเสร็จ
  async render(opts) {
    const dataUrl = await this.page.evaluate(o => window.composeCard(o), opts);
    const b64 = String(dataUrl).split(',')[1] || '';
    return Buffer.from(b64, 'base64');
  }

  async close() {
    try { if (this.browser) await this.browser.close(); } catch(e){}
    this.browser = null; this.page = null;
  }
}
