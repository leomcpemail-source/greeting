// scripts/lib/brain.mjs
// "หัวสมอง" ระบบเรียนรู้ (Phase 0) — เรียนจากภาพต้นแบบ refs ที่เจ้าของคัด + ปรับแหล่งรูปตามสภาพโควตา
// เป้าหมาย: (1) การ์ดหน้าตาใกล้ "ภาพสวัสดีที่คนนิยมส่งต่อจริง" มากขึ้นทุกคืน → เพิ่มยอดเซฟ/แชร์
//          (2) AI gen โควตาหมด → สลับไปรูปถ่าย Pexels (+CLIP local ตรวจ) อัตโนมัติ ไม่เสียรอบเปล่า
// กฎเหล็ก: ห้าม throw เด็ดขาด — ทุกอย่างล่ม = คืน null/ค่า default แล้วระบบทำงานแบบเดิมเป๊ะ
// ความจำ: เก็บใน <imgDir>/learn.json (อยู่บน branch daily-images — ติดไปทุกรอบ, decay 0.9/รอบ ~ความจำ 2 สัปดาห์)

import fs from 'node:fs';
import path from 'node:path';

const REFS_MIN = 8;        // refs น้อยกว่านี้ = ปิดสัญญาณ similarity (ตามแผน)
const TOPK = 5;            // sim ของการ์ด = ค่าเฉลี่ย top-5 ความใกล้เคียงกับ refs (กัน outlier)
const MIN_N = 3;           // สไตล์ที่มีตัวอย่างน้อยกว่านี้ ยังไม่ถ่วงน้ำหนัก (ใช้ 1.0)
const CLAMP_LO = 0.4, CLAMP_HI = 2.5, EXPLORE = 0.2, DECAY = 0.9;
// คัดทิ้ง-สร้างใหม่: ใบที่ sim ต่ำกว่าค่าเฉลี่ยมาก = "หน้าตาไม่เข้าพวกภาพยอดนิยม" → ทิ้งแล้ว gen แทน
const SIM_HIST_MIN = Number(process.env.LEARN_SIM_HIST_MIN || 30);   // ต้องเห็นการ์ดมาก่อนกี่ใบถึงกล้าคัด
const SIM_MARGIN = Number(process.env.LEARN_SIM_MARGIN || 0.12);     // ต่ำกว่าค่าเฉลี่ยเกินนี้ = คัดออก
const CULL_MAX = Number(process.env.LEARN_CULL_MAX || 12);           // เพดานคัดต่อรอบ (กัน loop ทิ้งไม่หยุด)

const cos = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };

export async function initBrain({ imgDir, sbUrl, sbAnon, secret, fetchT, names }) {
  try {
    const LEARN_FILE = path.join(imgDir, 'learn.json');
    const EMBED_FILE = path.join(imgDir, 'ref-embeds.json');

    // ── ความจำเดิม + decay (รอบเก่าค่อยๆ จางลง รับการเปลี่ยนใจของ user/refs ได้) ──
    let mem = { stats: {}, src: {} };
    try { mem = { stats: {}, src: {}, ...JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8')) }; } catch (e) {}
    const stats = {};
    for (const k of ['fr', 'lay', 'tx', 'ov']) {
      stats[k] = {};
      for (const [i, e] of Object.entries(mem.stats[k] || {}))
        if (e && e.n > 0.2) stats[k][i] = { n: e.n * DECAY, sum: e.sum * DECAY };
    }
    const carry = mem.src || {};   // ผลสำเร็จ/ล้มของแหล่งรูปจากรอบก่อน (ใช้เริ่มรอบนี้ได้เลย ไม่ต้องล้มซ้ำก่อนปรับ)
    const src = { genOk: 0, genFail: 0, photoOk: 0, photoFail: 0 };
    // การกระจายของ sim ที่เคยเห็น (รวมข้ามรอบ + decay) — ใช้ตั้งเกณฑ์คัดทิ้งแบบ relative
    const simHist = { n: (mem.simHist?.n || 0) * DECAY, sum: (mem.simHist?.sum || 0) * DECAY };
    let culled = 0;

    // ── ดึงภาพต้นแบบ refs จาก Supabase (ต้องมี LEARN_SECRET = รหัส dashboard) ──
    let refs = [], refsErr = '';
    if (!secret) refsErr = 'ยังไม่ตั้ง LEARN_SECRET';
    else {
      try {
        const r = await fetchT(`${sbUrl}/rest/v1/rpc/refs_list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: sbAnon, Authorization: 'Bearer ' + sbAnon },
          body: JSON.stringify({ pass: secret }),
        }, 30000);
        const d = await r.json();
        if (Array.isArray(d)) refs = d;
        else refsErr = d && d.error ? String(d.error) : 'รูปแบบตอบกลับผิด';
      } catch (e) { refsErr = e.message; }
    }

    // ── embedding ของ refs: cache ตาม id คิดครั้งเดียวต่อภาพ (CLIP โหลดเฉพาะเมื่อมี refs พอ) ──
    let refVecs = [], embedFn = null;
    if (refs.length >= REFS_MIN) {
      const lv = await import('./localvision.mjs');
      embedFn = lv.imageEmbed;
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(EMBED_FILE, 'utf8')) || {}; } catch (e) {}
      const fresh = {};
      for (const ref of refs) {
        const key = String(ref.id);
        if (cache[key]) { fresh[key] = cache[key]; continue; }
        const b64 = String(ref.img || '').split(',')[1];
        if (!b64) continue;
        const v = await embedFn(Buffer.from(b64, 'base64'));
        if (v) fresh[key] = v.map(x => Math.round(x * 1e4) / 1e4);  // ปัด 4 ตำแหน่ง ลดขนาดไฟล์
      }
      try { fs.writeFileSync(EMBED_FILE, JSON.stringify(fresh)); } catch (e) {}
      refVecs = Object.values(fresh);
    }
    const simEnabled = refVecs.length >= REFS_MIN;

    const weightsOf = (kind, n) => {
      const st = stats[kind] || {};
      let totN = 0, totSum = 0;
      for (const e of Object.values(st)) { totN += e.n; totSum += e.sum; }
      const global = totN > 0 ? totSum / totN : 0;
      const w = [];
      for (let i = 0; i < n; i++) {
        const e = st[i];
        if (!simEnabled || !e || e.n < MIN_N || global <= 0) { w.push(1); continue; }
        const raw = Math.min(CLAMP_HI, Math.max(CLAMP_LO, (e.sum / e.n) / global));
        w.push((1 - EXPLORE) * raw + EXPLORE);   // กัน 20% สำรวจถาวร — สไตล์ไหนก็ไม่ตายสนิท
      }
      return w;
    };

    return {
      refsCount: refs.length, refsErr, simEnabled,

      // สุ่ม index แบบถ่วงน้ำหนักตามที่เรียนมา (ไม่มีข้อมูลพอ = uniform เดิม)
      pickIdx(kind, n) {
        try {
          const w = weightsOf(kind, n);
          let tot = 0; for (const x of w) tot += x;
          let r = Math.random() * tot;
          for (let i = 0; i < n; i++) { r -= w[i]; if (r <= 0) return i; }
          return n - 1;
        } catch (e) { return Math.floor(Math.random() * n); }
      },

      // วัดว่าการ์ดใบนี้ "หน้าตาเหมือนภาพที่คนนิยมส่งต่อจริง" แค่ไหน (0..1) — null = วัดไม่ได้
      async scoreCard(buf) {
        try {
          if (!simEnabled || !embedFn) return null;
          const v = await embedFn(buf);
          if (!v) return null;
          const sims = refVecs.map(rv => cos(v, rv)).sort((a, b) => b - a);
          const top = sims.slice(0, Math.min(TOPK, sims.length));
          return Math.max(0, Math.min(1, top.reduce((s, x) => s + x, 0) / top.length));
        } catch (e) { return null; }
      },

      // จดผลของสไตล์ที่ใช้ (เรียกหลัง keep การ์ด)
      observe(sty, sim) {
        try {
          if (sim == null || !sty) return;
          simHist.n += 1; simHist.sum += sim;
          for (const [k, i] of Object.entries({ fr: sty.fr, lay: sty.lay, tx: sty.tx, ov: sty.ov })) {
            if (i == null) continue;
            const e = (stats[k][i] = stats[k][i] || { n: 0, sum: 0 });
            e.n += 1; e.sum += sim;
          }
        } catch (e) {}
      },

      // เกณฑ์คัดทิ้ง-สร้างใหม่: ใบที่ต่ำกว่าค่าเฉลี่ยที่เคยเห็นเกิน SIM_MARGIN (และพ้นพื้น 0.12)
      // เปิดเมื่อข้อมูลพอ (≥SIM_HIST_MIN ใบ) + มีเพดานต่อรอบ — กันคัดมั่ว/คัดไม่หยุดช่วงเริ่มเรียน
      simThreshold() {
        if (!simEnabled || simHist.n < SIM_HIST_MIN) return null;
        return Math.max(0.12, simHist.sum / simHist.n - SIM_MARGIN);
      },
      shouldReject(sim) {
        try {
          if (sim == null || culled >= CULL_MAX) return false;
          const thr = this.simThreshold();
          if (thr == null || sim >= thr) return false;
          culled++;
          return true;
        } catch (e) { return false; }
      },

      // จดผลของแหล่งรูป: 'gen' (AI สร้าง) / 'photo' (Pexels)
      srcEvent(kind, ok) {
        try { src[kind === 'gen' ? (ok ? 'genOk' : 'genFail') : (ok ? 'photoOk' : 'photoFail')]++; } catch (e) {}
      },

      // สัดส่วนรูปถ่ายแบบปรับตัว: AI gen ล้มเยอะ (โควตาหมด) → เทไปรูปถ่ายทันที ไม่เสียเวลารอ timeout ซ้ำๆ
      photoShare(base) {
        try {
          // ความจำ = รอบล่าสุดรอบเดียวเต็มน้ำหนัก (finish เขียนทับทุกรอบ) — โควตาตายรอบก่อน
          // รอบใหม่เริ่มที่สัดส่วนรูปถ่ายสูงทันที ไม่ต้องล้มซ้ำก่อน ; gen ฟื้น (ok เพิ่ม) ก็คืนค่าเอง
          const gOk = src.genOk + (carry.genOk || 0);
          const gFail = src.genFail + (carry.genFail || 0);
          const tot = gOk + gFail;
          if (tot < 3) return base;                              // ข้อมูลน้อย — ใช้ค่า config เดิม
          const failRate = gFail / tot;
          let share = base;
          if (failRate >= 0.6) share = base + 0.4;
          else if (failRate >= 0.35) share = base + 0.2;
          else if (failRate <= 0.1) share = base;               // gen กลับมาปกติ → คืนค่า config
          return Math.min(0.95, Math.max(0.2, share));
        } catch (e) { return base; }
      },

      // ปิดรอบ: บันทึกความจำ + คืน "ประโยคที่เรียนรู้" ให้ learn-log
      finish(photoShareBase) {
        const notes = [];
        try {
          fs.writeFileSync(LEARN_FILE, JSON.stringify({ stats, simHist, src: { ...src, ts: Date.now() } }));
          if (culled > 0) {
            const thr = this.simThreshold();
            notes.push(`คัดการ์ดหน้าตาไม่เข้าพวกภาพยอดนิยมออก ${culled} ใบ (sim ต่ำกว่า ${thr != null ? Math.round(thr * 100) + '%' : 'เกณฑ์'}) แล้วสร้างใบใหม่แทนทันที`);
          }
          if (simEnabled) {
            // หาสไตล์เด่น/อ่อนจากข้อมูลที่มีพอ — รายงานเป็นภาษาคน
            const pick = (kind, label, arr) => {
              const es = Object.entries(stats[kind] || {}).filter(([, e]) => e.n >= MIN_N);
              if (es.length < 2) return;
              es.sort((a, b) => (b[1].sum / b[1].n) - (a[1].sum / a[1].n));
              const nm = i => (arr && arr[i]) ? arr[i] : ('#' + i);
              const [bi, be] = es[0], [wi, we] = es[es.length - 1];
              notes.push(`${label}ที่ใกล้ภาพยอดนิยมสุด: ${nm(+bi)} (${Math.round(be.sum / be.n * 100)}%) → สร้างบ่อยขึ้น · อ่อนสุด: ${nm(+wi)} (${Math.round(we.sum / we.n * 100)}%) → ลดลง`);
            };
            pick('fr', 'กรอบ', names && names.fr);
            pick('lay', 'เลย์เอาต์', names && names.lay);
            pick('tx', 'ขนาดตัวอักษร', names && names.tx);
            notes.unshift(`เรียนจากภาพต้นแบบ ${this.refsCount} ใบ ของเจ้าของ (CLIP similarity)`);
          } else {
            notes.push(`สัญญาณภาพต้นแบบยังปิด (refs ${this.refsCount} ใบ${this.refsErr ? ' · ' + this.refsErr : ''} — ต้องมี ≥${REFS_MIN} ใบ + ตั้ง LEARN_SECRET)`);
          }
          const tot = src.genOk + src.genFail;
          if (tot >= 3 && photoShareBase != null) {
            const share = this.photoShare(photoShareBase);
            if (share > photoShareBase + 0.05)
              notes.push(`AI gen รูปล้ม ${Math.round(src.genFail / tot * 100)}% (โควตา/ล่ม) → สลับไปรูปถ่าย Pexels ${Math.round(share * 100)}% ชั่วคราว (ปกติ ${Math.round(photoShareBase * 100)}%) — รูปถ่ายผ่านด่าน CLIP local ของเราเองเสมอ`);
            else if (src.genFail === 0 && src.genOk >= 5)
              notes.push(`AI gen รูปทำงานปกติ (สำเร็จ ${src.genOk} ครั้ง) — ใช้สัดส่วนตามตั้งค่า`);
          }
        } catch (e) {}
        return notes;
      },
    };
  } catch (e) {
    console.log(`  ! brain init: ${e.message} — สุ่มแบบเดิม`);
    return null;
  }
}
