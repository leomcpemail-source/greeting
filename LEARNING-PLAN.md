# แผนระบบเรียนรู้อัตโนมัติ (Self-Learning Loop) — design doc

> สถานะ: **แผน ยังไม่ลงมือ** (มิ.ย. 2569) — เจ้าของให้ทำแผนละเอียดก่อนตัดสินใจ
> เป้าหมาย: เว็บปรับ "สไตล์การ์ด + เนื้อหาภาพ + คำอวยพร" เองทุกคืน ให้ตรงใจ user
> โจทย์เพิ่ม (เจ้าของชี้): ตอนนี้ user ยังน้อย → cold start หนัก → ต้อง **เรียนจากภายนอกก่อน (Phase 0)**
> แล้วค่อยถ่ายน้ำหนักไปเรียนจาก user จริงโดยอัตโนมัติเมื่อยอดใช้งานโตพอ

## ภาพรวม loop

```
Phase 0 (เริ่มทันที ไม่ต้องรอ user):
  refs/ ภาพยอดนิยมจริงที่เจ้าของคัด ──> CLIP embedding ──┐
  Gemini "user จำลองวัย 60+" ให้คะแนนน่าส่งต่อ ───────────┤──> brain คำนวณน้ำหนักสไตล์/เนื้อหา
  Gemini trend scout รายสัปดาห์ ──> subject/คำอวยพรใหม่ ──┘         │
                                                                    ▼
Phase 1 (อัตโนมัติเมื่อข้อมูลพอ):                       generate.mjs สุ่มแบบถ่วงน้ำหนัก
  user กดเซฟ/แชร์ ──> Supabase ──> สัญญาณ user จริง ──> ค่อยๆ กลายเป็นเสียงหลักเอง
```

- สูตรผสมสัญญาณ: `score = user_signal × n/(n+50) + external_signal × 50/(n+50)`
  (n = จำนวนกดเซฟ/แชร์สะสมของสไตล์นั้น) — **ไม่ต้องสลับโหมดเอง** วันแรกฟังภายนอก ~100%
  พอ user จริงสะสมหลักร้อย เสียง user กลายเป็นหลักโดยธรรมชาติ
- "หัวสมอง" = สูตร bandit ตรงไปตรงมา (LLM ใช้เป็นแหล่งสัญญาณ ไม่ใช่ตัวคำนวณ)
- ทุกชั้น **fail-safe**: แหล่งไหนล่ม → ตัดออกจากส่วนผสม, ล่มหมด → สุ่ม uniform แบบปัจจุบัน
- kill switch: env `USE_LEARNING=0` ใน daily.yml ปิดได้ทันที

---

## Phase 0 — เรียนรู้จากภายนอก (ทำก่อน — ไม่ต้องรอ user)

### 0a. Reference set: ภาพยอดนิยมจริงที่เจ้าของคัดเอง (สัญญาณแม่นสุด)
- ✅ **ติดตั้งส่วนจัดการแล้ว (มิ.ย.2569)**: เก็บใน Supabase (ตาราง `refs` + RPC ล็อกด้วยรหัส dashboard
  — ไฟล์ `refs-schema.sql` ต้องรันใน SQL Editor ครั้งเดียว ใส่ secret เดิม) จัดการผ่านแผงใน **db.html**:
  อัปโหลดหลายรูปทีเดียว (ย่อเหลือ 512px ฝั่งเบราว์เซอร์ ~60KB/ใบ, เพดาน 100 ใบ), เห็น preview ทุกใบ, กด ✕ ลบ
  — ไม่ต้องเข้า GitHub
- ทุก run: pipeline ดึง refs ผ่าน `refs_list` (env `LEARN_SECRET`) → CLIP แปลงเป็น embedding
  cache ใน `output/ref-embeds.json` ตาม id (คิดครั้งเดียวต่อภาพ ไม่เปลือง)
- ทุกใบที่ bake: คิด cosine similarity กับ ref set → `simScore` ต่อใบ
  - ใช้จัดลำดับใน manifest: ใบ "หน้าตาแบบที่คนส่งกันจริง" ขึ้นก่อน (first impression สำคัญช่วง user น้อย)
  - brain รวม simScore เฉลี่ยต่อสไตล์/เนื้อหา → ถ่วงน้ำหนักการสร้าง
- **พฤติกรรมเมื่อ refs ขาด (กติกาตายตัว):** refs เก็บถาวร ไม่ใช่ของรายวัน — "ลืมอัปโหลด" ไม่มีผล ระบบใช้ชุดเดิมต่อ;
  ถ้า refs **< 8 ใบ** หรือดึงไม่ได้/ยังไม่ติดตั้ง → brain ตัดสัญญาณ simScore ออก (น้ำหนัก 0) เหลือสัญญาณ
  Gemini shareability + trend; ถ้าล่มหมดทุกสัญญาณ → สุ่ม uniform แบบปัจจุบัน **ไม่มีทาง crash / การ์ดยังออกทุกวันปกติ**
- ข้อกฎหมาย: ภาพ refs ใช้คำนวณสถิติภายในเท่านั้น ไม่ถูกเผยแพร่/ทำซ้ำในผลงาน และอยู่ในตาราง Supabase
  ที่ anon อ่านตรงไม่ได้ (RLS ไม่มี policy, เข้าได้เฉพาะ RPC ที่เช็ค secret) — ปลอดภัยกว่า scrape เน็ตมาก

### 0b. Gemini เป็น "user จำลองวัย 60+" (ได้ผลตั้งแต่วันแรก, ฟรี — ไม่เพิ่ม API call)
- rubric vision เดิมตรวจทุกใบอยู่แล้ว → เพิ่มเกณฑ์ `shareability`: "คนไทยวัย 60+ อยากกดส่งต่อภาพนี้
  ใน LINE แค่ไหน (1-10)" ในคำขอเดียวกัน
- จดคะแนนแยกตามสไตล์ลง px_keep → หัวสมองใช้เป็น proxy ของ CTR จนกว่า user จริงจะพอ
- ความเสี่ยง: รสนิยม LLM ≠ รสนิยมจริง 100% → จึงให้ 0a (ภาพจริง) เป็นสัญญาณนำ, 0b เป็นตัวเสริม

### 0c. Gemini trend scout (รายสัปดาห์) — ย้ายขึ้นมาจาก Phase 2 เดิม
- run แรกของวันอาทิตย์: ถามเทรนด์ภาพ/คำอวยพรตามเดือน+เทศกาลที่ใกล้เข้ามา → subject 10 ข้อ + คำอวยพร 10 บท
- ผ่านตัวกรองเดิมทั้งหมด (validCardText, keyword ต้องห้าม, rubric, CLIP) — trend ใช้ไม่เกิน ~30% ของ gen
- เก็บ `output/trends.json`

**ไฟล์ที่แตะใน Phase 0:** generate.mjs (จด sty ต่อใบ + สุ่มถ่วงน้ำหนัก + จุดเรียก), rubric.mjs (เกณฑ์
shareability), ใหม่: brain.mjs, refs/ + ส่วนขยาย localvision.mjs (embedding), trends.mjs, daily.yml (env)
**ของที่เจ้าของต้องทำ:** หย่อนภาพตัวอย่างลง refs/ (เริ่ม 20+ ใบยิ่งดี) — SQL/secret ยังไม่ต้องทำใน Phase 0

---

## Phase 1 — เรียนรู้จาก user จริง (เปิดรอไว้ สัญญาณจะค่อยๆ เข้ามาแทนเอง)

### 1.1 จดสไตล์ต่อใบ (`scripts/generate.mjs`)
ปัจจุบัน `renderCard` สุ่ม index กรอบ/layout/ขนาดตัวอักษร/overlay **ภายในฟังก์ชัน แล้วทิ้ง** — ไม่มีใครรู้ว่าการ์ดใบไหนใช้สไตล์อะไร

แก้:
- ยก random index ออกมานอก `renderer.render(...)` → ได้ `sty=[frIdx,layIdx,txIdx,ovIdx]`
- เก็บ `sty` ลง `st.images` entry (ติดไป manifest → เว็บเห็นด้วย)
- `supaLog('px_keep', {..., sty})` → ฝั่ง SQL รู้ว่า "วันนี้ bake สไตล์ไหนไปกี่ใบ" (= ตัวหารของ CTR
  ไม่ต้องยิง event 'view' จากเว็บทุกครั้งที่ปัด ซึ่งจะถล่ม Supabase free tier)

### 1.2 ส่งสัญญาณจากเว็บ (`index.html`)
- `track2(type, card)` — เฉพาะ event `download` / `copy` / `line` / `next` แนบ
  `ref: JSON.stringify({f:file, cat, sty})` (คอลัมน์ `ref` เป็น text อยู่แล้ว **ไม่ต้อง migrate schema**;
  ref ของ user event เดิมเก็บ referrer ซึ่ง dashboard ไม่ได้ใช้ → ใช้แทนได้ปลอดภัย)
- สัญญาณ: บวกแรง = download/copy/line (น้ำหนัก +3) ; ลบอ่อน = next ภายใน <2 วิหลังเห็นการ์ด (−1, ตีความว่า "ปัดหนี")
  — v1 เริ่มจากสัญญาณบวกอย่างเดียวก่อนก็พอ (ง่าย เสถียร) ค่อยเติมลบทีหลัง

### 1.3 RPC อ่านสถิติ (ไฟล์ใหม่ `learning-stats.sql` — รันใน Supabase ครั้งเดียว)
```
style_stats(secret text, days int default 14) → JSON
  { by_fr:[{i,baked,pos}], by_lay:[...], by_tx:[...], by_cat:[{cat,baked,pos}], by_src:{photo,gen} }
```
- baked นับจาก px_keep (ref::jsonb->'sty'), pos นับจาก download/copy/line (ref::jsonb->'sty')
- ป้องกันด้วย secret เดียวกับ dashboard (ส่งผ่าน GH secret ใหม่ `LEARN_SECRET`) — read-only aggregate เท่านั้น
- ⚠️ เหมือน analytics-schema-v2: **ต้องแก้ secret ก่อนรัน** และไฟล์ .sql ในรีโปเป็นแค่สำเนา ของจริงอยู่ใน Supabase

### 1.4 หัวสมอง (ไฟล์ใหม่ `scripts/lib/brain.mjs`)
- เรียกตอนต้น run: `loadWeights()` → ดึง style_stats (timeout สั้น, ล่ม → null = uniform)
- สูตรต่อ index: `rate = (pos + 1) / (baked + 20)` (smoothing — ข้อมูลน้อยจะลู่เข้าค่าเฉลี่ยรวม ไม่แกว่ง)
  `weight = clamp(rate / rateรวม, 0.4, 2.5)` แล้วผสม exploration: `final = 0.8*weight + 0.2`
  → สไตล์ยอดนิยมออกบ่อยขึ้นสูงสุด ~2 เท่า, สไตล์แป้กยังโผล่ ~ครึ่งเดิม (ไม่ตาย — เผื่อใจ user เปลี่ยน)
- เขียนผล `output/learn.json` ทุก run (อยู่ใน branch daily-images → debug/ดูย้อนหลังได้, อายุข้อมูล 14 วัน rolling)
- สิ่งที่ปรับ: น้ำหนัก FRAMES / LAYOUTS / TEXT_SIZES / OVERLAYS, ลำดับเติมหมวด (เฉพาะ "ลำดับ"
  — **ไม่แตะ CAT_TARGET 30/หมวด** ที่เจ้าของกำหนด), และ PHOTO_SHARE ±0.1 รอบค่า config (ขอบเขต 0.3–0.7)

### 1.5 สุ่มถ่วงน้ำหนัก (`generate.mjs`)
- `pickWeightedIdx(n, weights)` แทน `Math.floor(Math.random()*n)` เฉพาะ 4 จุดสุ่มสไตล์ — weights ว่าง/พัง → uniform เดิม
- env `USE_LEARNING` (default '1') + ใส่ใน daily.yml ทั้งสองที่ตามกฎโปรเจกต์

### 1.6 (ออปชัน) แผงดูน้ำหนักใน db.html
- อ่าน `learn.json` ตรงจาก branch daily-images (raw URL — ไม่ต้องมี SQL เพิ่ม) แสดง top/bottom สไตล์
  ให้เจ้าของเห็นว่าระบบกำลังเอียงไปทางไหน

**ไฟล์ที่แตะ:** generate.mjs, index.html, daily.yml, ใหม่: brain.mjs + learning-stats.sql (+db.html ออปชัน)
**ของที่เจ้าของต้องทำเอง:** รัน learning-stats.sql ใน Supabase (ใส่ secret), เพิ่ม GH secret `LEARN_SECRET`

---

## Phase 2 — CLIP แท็กเนื้อหา (เรียนลึกถึง "ในภาพมีอะไร")

- ใช้ CLIP local ที่ติดตั้งแล้ว แท็กการ์ดทุกใบที่ keep ด้วย CONTENT_LABELS
  (บัว/ดาวเรือง/กุหลาบ/พระพุทธรูป/พระอาทิตย์ขึ้น/ภูเขา/ทะเล/แมว/หมา/กาแฟ/…) → เก็บ `cnt` ใน manifest + px_keep
- brain รวมยอดเซฟต่อ label → ถ่วงการเลือก subject ในหมวด (เช่น บัวชนะกุหลาบชัด → หมวดดอกไม้ gen บัวบ่อยขึ้น)
- ต้นทุน: CLIP โหลดอยู่แล้ว เพิ่ม ~1-2 วิ/ใบ บน Actions — อยู่ในงบเวลา
- ไฟล์: ขยาย localvision.mjs (เพิ่ม label ชุดที่สอง + ฟังก์ชัน tag), brain.mjs, generate.mjs จุดเลือก subject

---

## ความเสี่ยง / ข้อจำกัด

| เรื่อง | ผล | ทางรับมือ |
|---|---|---|
| Cold start — user ยังน้อย | สัญญาณภายในไม่พอเรียน | **Phase 0**: refs จริง + Gemini จำลอง user ทำงานตั้งแต่วันแรก; สูตร n/(n+50) ถ่ายไป user จริงเองเมื่อข้อมูลพอ |
| รสนิยม Gemini ≠ user จริง | proxy เพี้ยนได้ | ให้ refs (ภาพจริง) เป็นสัญญาณนำ, Gemini เป็นรอง, และ user จริงทับทั้งคู่เมื่อโตพอ |
| refs น้อย/เอียงตามคนคัด | เรียนแคบ | เริ่ม 20+ ใบ คละหมวด; เติมเรื่อยๆ; exploration 20% กันตัน |
| Feedback loop เอียงสุดทาง | การ์ดหน้าตาซ้ำซาก | clamp 0.4–2.5 + exploration 20% ถาวร |
| Supabase ล่ม/secret ผิด | ไม่มีข้อมูลเรียน | fail-safe → uniform (พฤติกรรมปัจจุบันเป๊ะ) |
| ref ถูก reuse | referrer ของ event เหล่านี้หาย | dashboard ไม่ได้ใช้ ref ฝั่ง user อยู่แล้ว |
| Privacy | — | ไม่เก็บข้อมูลส่วนตัวเพิ่ม แค่ index สไตล์แนบ event เดิม |

## ตัววัดความสำเร็จ
- Phase 0: simScore เฉลี่ยของการ์ดที่ bake สูงขึ้นสัปดาห์ต่อสัปดาห์ (= หน้าตาเข้าใกล้ภาพที่นิยมจริง)
- Phase 1: อัตรา (download+copy)/open รายสัปดาห์ใน db.html ค่อยๆ สูงขึ้น (มีกราฟอยู่แล้ว)
- learn.json แสดงการกระจายสไตล์เอียงตามจริง ไม่ติดขอบ clamp ทั้งกระดาน

## ลำดับลงมือ + ประมาณงาน
1. **Phase 0** (~1 session): refs/ + CLIP similarity + shareability ใน rubric + trend scout + brain v1
   — เริ่มเห็นผลทันทีโดยไม่ต้องรอ user; เจ้าของแค่หย่อนภาพ refs
2. **Phase 1** (~ครึ่ง-1 session): เดินสายสัญญาณ user จริง (track2 + SQL) — เปิดรอไว้ ถ่ายน้ำหนักเองตามสูตร
3. **Phase 2** (~ครึ่ง session): CLIP แท็กเนื้อหา — ทำหลังมีข้อมูลแล้วจูนง่ายกว่า
