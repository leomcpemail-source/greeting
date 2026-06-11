# แผนระบบเรียนรู้อัตโนมัติ (Self-Learning Loop) — design doc

> สถานะ: **แผน ยังไม่ลงมือ** (มิ.ย. 2569) — เจ้าของให้ทำแผนละเอียดก่อนตัดสินใจ
> เป้าหมาย: เว็บปรับ "สไตล์การ์ด + เนื้อหาภาพ + คำอวยพร" เองทุกคืน ตามพฤติกรรมจริงของ user
> หลักการ: เรียนรู้จาก **user ของเราเอง** (ยอดเซฟ/แชร์ = เสียงโหวต) ไม่ scrape รูปจากเน็ต (ติดลิขสิทธิ์/ToS
> และเดาใจคนทั้งเน็ตแทนที่จะเป็น user จริง) — ความรู้เทรนด์ภายนอกใช้ Gemini เป็น trend scout แทน

## ภาพรวม loop

```
user กดบันทึก/ส่ง LINE/เปลี่ยนรูป ──> Supabase events (จด: ไฟล์, หมวด, sty=[กรอบ,layout,ขนาดตัว,overlay])
        ▲                                                  │
        │                                                  ▼  ทุกคืน (ใน run แรกของวัน)
  การ์ดชุดใหม่ <── generate.mjs สุ่มแบบถ่วงน้ำหนัก <── brain.mjs ดึงสถิติผ่าน RPC แล้วคำนวณน้ำหนัก
                   (อิง learn.json)                    (บันทึก output/learn.json — คงอยู่ใน branch daily-images)
```

- "หัวสมอง" = สูตร bandit ตรงไปตรงมา (ไม่ใช้ LLM ในแกนหลัก — เร็ว ฟรี ตรวจสอบได้)
- ทุกชั้น **fail-safe**: RPC ล่ม / ไม่มีข้อมูล / parse พัง → ถอยกลับสุ่ม uniform แบบปัจจุบัน (แบบเดียวกับ localvision)
- kill switch: env `USE_LEARNING=0` ใน daily.yml ปิดได้ทันที

---

## Phase 1 — เรียนรู้จากพฤติกรรม user (แกนหลัก)

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

## Phase 2 — Gemini trend scout (ความรู้จากโลกภายนอก แบบถูกกฎ)

- สัปดาห์ละครั้ง (run แรกของวันอาทิตย์): ถาม Gemini — เดือนนี้/เทศกาลที่ใกล้เข้ามา ผู้สูงอายุไทยนิยม
  ส่งภาพสวัสดี+คำอวยพรแนวไหน → ขอ subject ภาษาอังกฤษ 10 ข้อ (สำหรับ gen รูป) + คำอวยพร 10 บท
- ผ่านตัวกรองเดิมทั้งหมด: `validCardText`, keyword ต้องห้าม, และรูปที่ gen ยังเข้า rubric vision + CLIP ตามปกติ
- เก็บ `output/trends.json` แล้วผสมเข้า pool subject แบบจำกัดเพดาน (trend ใช้ไม่เกิน ~30% ของ gen)
  → ระบบ "รู้เทรนด์" โดยไม่ scrape ภาพใคร
- ไฟล์: ใหม่ `scripts/lib/trends.mjs` + จุดเรียกใน generate.mjs (~15 บรรทัด)

## Phase 3 — CLIP แท็กเนื้อหา (เรียนลึกถึง "ในภาพมีอะไร")

- ใช้ CLIP local ที่ติดตั้งแล้ว แท็กการ์ดทุกใบที่ keep ด้วย CONTENT_LABELS
  (บัว/ดาวเรือง/กุหลาบ/พระพุทธรูป/พระอาทิตย์ขึ้น/ภูเขา/ทะเล/แมว/หมา/กาแฟ/…) → เก็บ `cnt` ใน manifest + px_keep
- brain รวมยอดเซฟต่อ label → ถ่วงการเลือก subject ในหมวด (เช่น บัวชนะกุหลาบชัด → หมวดดอกไม้ gen บัวบ่อยขึ้น)
- ต้นทุน: CLIP โหลดอยู่แล้ว เพิ่ม ~1-2 วิ/ใบ บน Actions — อยู่ในงบเวลา
- ไฟล์: ขยาย localvision.mjs (เพิ่ม label ชุดที่สอง + ฟังก์ชัน tag), brain.mjs, generate.mjs จุดเลือก subject

---

## ความเสี่ยง / ข้อจำกัด

| เรื่อง | ผล | ทางรับมือ |
|---|---|---|
| Cold start — ยอดกดยังน้อย | ช่วงแรกน้ำหนักแทบไม่ขยับ | smoothing ทำให้ลู่เข้า uniform เอง; เริ่มเห็นผลจริง ~1-2 สัปดาห์ (หลักร้อยกด/สไตล์) |
| Feedback loop เอียงสุดทาง | การ์ดหน้าตาซ้ำซาก | clamp 0.4–2.5 + exploration 20% ถาวร |
| Supabase ล่ม/secret ผิด | ไม่มีข้อมูลเรียน | fail-safe → uniform (พฤติกรรมปัจจุบันเป๊ะ) |
| ref ถูก reuse | referrer ของ event เหล่านี้หาย | dashboard ไม่ได้ใช้ ref ฝั่ง user อยู่แล้ว |
| Privacy | — | ไม่เก็บข้อมูลส่วนตัวเพิ่ม แค่ index สไตล์แนบ event เดิม |

## ตัววัดความสำเร็จ
- อัตรา (download+copy)/open รายสัปดาห์ใน db.html ค่อยๆ สูงขึ้น (มีกราฟอยู่แล้ว)
- learn.json แสดงการกระจายสไตล์เอียงตามจริง ไม่ติดขอบ clamp ทั้งกระดาน

## ประมาณงาน
- Phase 1: ~1 session (โค้ด + SQL + ทดสอบ) — คุ้มสุด แนะนำเริ่มก่อน
- Phase 2: ~ครึ่ง session ; Phase 3: ~ครึ่ง session (ทำหลัง Phase 1 มีข้อมูลแล้วจะจูนง่ายกว่า)
