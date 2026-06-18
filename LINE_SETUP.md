# ตั้งค่า LINE Official Account — ส่งคำอวยพรให้เพื่อนทุกเช้า 06:00 น.

คู่มือนี้พาตั้งค่าให้ระบบ **ส่งรูปอวยพรของวัน + ข้อความ ไปหาเพื่อนทีละคนทุกเช้า** ผ่าน LINE
ทำตามทีละขั้นแบบไม่ต้องเขียนโค้ดเพิ่ม (โค้ดทำไว้ให้แล้วใน repo)

## ภาพรวมระบบ

```
คนกด "เพิ่มเพื่อน" LINE OA
        │  (LINE ยิง webhook)
        ▼
Supabase Edge Function  line-webhook  ──► เก็บ userId ลงตาราง line_friends
        ▲                                          │
        │                                          │ อ่านรายชื่อ active ทุกเช้า
ส่งข้อความต้อนรับ                                   ▼
                              GitHub Actions  line-morning  (06:00 ไทย)
                                     │
                                     ├─ หยิบรูป+คำอวยพรของวันจาก branch daily-images
                                     └─ push ไปหาเพื่อน "ทีละคน"
```

- **ทำไมต้องมี Supabase:** เว็บเป็นสแตติก ยิง webhook รับเองไม่ได้ จึงต้องมี Edge Function คอยรับตอนมีคนเพิ่มเพื่อน เพื่อเก็บ `userId` (ต้องมี userId ถึงจะส่งหารายคนได้)
- **ทำไมส่งด้วย GitHub Actions:** repo นี้สร้างรูปรายวันด้วย Actions อยู่แล้ว ใช้รูปชุดเดียวกันส่งได้เลย และดูง่ายใน repo

> ใช้ Supabase **โปรเจกต์เดียวกับที่เว็บใช้อยู่** (ดูค่า `SB_URL` ในไฟล์ `index.html`) เพื่อให้ทุกอย่างอยู่ที่เดียว

---

## ขั้นที่ 1 — สร้าง LINE Official Account + เปิด Messaging API

1. เข้า https://manager.line.biz/ แล้วล็อกอินด้วยบัญชี LINE → กด **สร้างบัญชีใหม่ (Create)** กรอกชื่อ/หมวดหมู่ให้เรียบร้อย
2. เข้า https://developers.line.biz/console/ → สร้าง **Provider** (ชื่ออะไรก็ได้ เช่น ชื่อแบรนด์)
3. ในเมนู **Settings ของ OA** ฝั่ง LINE Official Account Manager:
   - **Messaging API → Enable** (เชื่อม OA เข้ากับ provider ที่สร้าง)
   - ปิด **Auto-reply messages** และ **Greeting messages** (เราจะส่งต้อนรับเองจาก webhook) — ที่หน้า *Settings → Response settings*
   - เปิด **Webhooks = ON**
4. กลับไปที่ LINE Developers Console → เปิด **channel แบบ Messaging API** ที่เพิ่งสร้าง แล้วเก็บค่า 2 ตัวนี้:
   - แท็บ **Basic settings → Channel secret**  → จดไว้เป็น `LINE_CHANNEL_SECRET`
   - แท็บ **Messaging API → Channel access token (long-lived)** → กด **Issue** แล้วจดไว้เป็น `LINE_CHANNEL_ACCESS_TOKEN`

> เก็บโทเคนทั้งสองเป็นความลับ อย่า commit ลง repo

---

## ขั้นที่ 2–4 — หลังบ้านบน Supabase ✅ (ติดตั้ง + ตั้งค่า + ทดสอบให้แล้วทั้งหมด)

ทำให้เรียบร้อยแล้วบนโปรเจกต์ Supabase **`iuyiwpoupnuxnohpatyw`**:

- ✅ ตาราง `line_friends` (เปิด RLS — เข้าถึงเฉพาะ service role)
- ✅ Edge Function `line-webhook` — รับ follow/unfollow/message (ฝัง channel secret + access token ไว้ในฟังก์ชัน ไม่ต้องตั้ง secret เอง)
- ✅ ตั้ง **Webhook URL** ให้ LINE แล้ว + ทดสอบผ่าน (`success: true`) + `active: true`
  ```
  https://iuyiwpoupnuxnohpatyw.supabase.co/functions/v1/line-webhook
  ```
- ✅ Edge Function `line-morning` — ส่งรูป+คำอวยพรของวันหาเพื่อนทีละคน
- ✅ ตั้ง **pg_cron** ยิงทุกวัน 23:00 UTC = **06:00 น. (ไทย)** อัตโนมัติ (ดู `supabase/cron/line_morning_schedule.sql`)

> **ไม่ต้องตั้ง GitHub Secrets / Supabase secrets ใด ๆ เพิ่ม** — ตัวส่งตอนเช้าทำงานบน Supabase cron ทั้งหมด
>
> หมายเหตุความปลอดภัย: ตอนนี้ฝัง token/secret ไว้ในซอร์สของฟังก์ชันบน Supabase (ไม่ได้อยู่ใน git) เพื่อให้ใช้งานได้เลย ถ้าต้องการแบบมาตรฐานกว่า ย้ายไปตั้งเป็น Edge Function secrets (`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `CRON_KEY`) แล้ว deploy ไฟล์ในโฟลเดอร์ `supabase/functions/` ทับได้ (ฟังก์ชันอ่าน ENV ก่อนเสมอ)
>
> โปรเจกต์นี้ใช้ร่วมกับ workplace-planner แต่ตาราง/ฟังก์ชันของ LINE แยกอิสระ ถ้าอยากย้ายไปโปรเจกต์ของเว็บ (`bbtmcwydwscjjoxydbfp`) บอกได้

**เหลือฝั่ง LINE ที่ต้องกดเองในคอนโซล (ทำครั้งเดียว):**
1. แท็บ **Messaging API → Use webhook = ON** ✅ (เปิดแล้ว)
2. (แนะนำ) **Response mode = Bot** และปิด **Auto-reply / Greeting message** ที่ LINE OA Manager → *Settings → Response settings* เพื่อไม่ให้ข้อความอัตโนมัติของ LINE ชนกับ webhook
3. **เพิ่ม OA เป็นเพื่อน** เพื่อทดสอบ → จะได้ข้อความต้อนรับ และมีแถวเพิ่มใน `line_friends`

---

## ขั้นที่ 5 — เมนู (Rich Menu) "หน้าแรก / ตามหมวด" ✅ (ติดตั้งให้แล้ว)

ติดตั้งเรียบร้อยแล้ว เป็นเมนู 2 ระดับ (ใช้ฟีเจอร์ *rich menu switch* ของ LINE):

```
เมนูหลัก:   [ หน้าแรก ] [ ตามหมวด ]
                 │           │
       เปิดเว็บแอพหน้าแรก   สลับเป็นเมนูย่อย ▼
                             ┌─────────────────────────────┐
                             │            ‹ กลับ           │
                             │ ดอกไม้ ธรรมะ กำลังใจ คิดถึง  │
                             │ วันเกิด ผู้สูงวัย สุขภาพ เทศกาล │
                             │ ครอบครัว สัตว์เลี้ยง กาแฟ วิว │
                             └─────────────────────────────┘
                                กดหมวดไหน → เปิดเว็บแอพเข้าหมวดนั้น (?cat=...)
```

- รูปต้นฉบับอยู่ที่ `assets/richmenu/main.jpg` + `categories.jpg`
- ติดตั้งโดย Edge Function **`line-richmenu-install`** — ดึงรูปจาก repo → **resize เป็น 2500×843 อัตโนมัติ** (ImageScript) → อัปโหลด + ผูก alias + ตั้ง default
- เว็บรองรับ deep-link `?cat=<id>` (เพิ่มแบบไม่กระทบของเดิม) — เปิด `…/greeting/?cat=flowers` เด้งเข้าหมวดดอกไม้ทันที

### เปลี่ยนรูปเมนูภายหลัง

1. แทนไฟล์ `assets/richmenu/main.jpg` / `categories.jpg` (อัตราส่วนแนะนำ ~2.97:1 เช่น 1525×513 หรือ 2500×843 ; ระบบ resize ให้เอง) แล้ว commit
2. เรียกฟังก์ชันติดตั้งใหม่ (ลบของเดิม + สร้างใหม่ให้):
   ```sql
   -- รันใน Supabase SQL Editor
   select extensions.http_set_curlopt('CURLOPT_TIMEOUT','90');
   select status, content from extensions.http(ROW(
     'POST','https://iuyiwpoupnuxnohpatyw.supabase.co/functions/v1/line-richmenu-install',
     ARRAY[extensions.http_header('x-cron-key','<CRON_KEY>')], 'application/json','{}'
   )::extensions.http_request);
   ```

> เลย์เอาต์ช่องกด (area) อิงสัดส่วนคงที่: เมนูหลักแบ่งซ้าย-ขวาที่กึ่งกลาง; เมนูหมวดมีแถบบน ~11% + กริด 4×3 เท่า ๆ กัน — ออกแบบรูปให้ช่องตรงสัดส่วนนี้ จุดกดจะตรงเสมอ

---

## เกร็ดและการดูแล

- **ส่งทีละคน:** ใช้ LINE push API ยิงรายคน (ไม่ใช่ broadcast) ตามที่ต้องการ — เผื่ออนาคตอยากใส่ชื่อ/ปรับข้อความเฉพาะคน
- **คนบล็อก/ลบเพื่อน:** webhook จับ `unfollow` แล้วตั้ง `active=false` ให้เอง จะได้ไม่ส่งซ้ำ (ถ้าส่งไปโดน error ก็ข้ามคนนั้น ไม่ล้มทั้งรอบ)
- **เปลี่ยนเวลา:** แก้ schedule ใน `cron.schedule('line-morning-0600th', ...)` (รัน `supabase/cron/line_morning_schedule.sql` ใหม่) — **เปลี่ยนข้อความ:** แก้ `composeText` ใน `supabase/functions/line-morning/index.ts` แล้ว `supabase functions deploy line-morning`
- **โควตาข้อความ:** LINE OA แบบฟรีมีโควตา push ต่อเดือนจำกัด ถ้าเพื่อนเยอะให้ดูแพ็กเกจของ LINE OA
- **รูปของวัน:** หยิบจาก branch `daily-images` โฟลเดอร์วันนี้ (ตามเวลาไทย) ไม่มีก็ใช้ `evergreen` — เป็นรูปที่ baked ข้อความเสร็จแล้ว ส่งเป็นรูปได้เลย พร้อมแนบข้อความคำอวยพรอีกหนึ่งบับเบิล
