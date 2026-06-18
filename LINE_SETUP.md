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

## ขั้นที่ 2 — ติดตั้งหลังบ้านบน Supabase

ใช้ [Supabase CLI](https://supabase.com/docs/guides/cli) (หรือทำผ่านหน้าเว็บ Dashboard ก็ได้)

```bash
# ผูกกับโปรเจกต์ที่เว็บใช้ (เอา project-ref จาก SB_URL ใน index.html: https://<ref>.supabase.co)
supabase login
supabase link --project-ref <PROJECT_REF>

# 2.1 สร้างตาราง line_friends
supabase db push        # ใช้ migration ในโฟลเดอร์ supabase/migrations
# หรือคัดลอก SQL จาก supabase/migrations/20260618000000_line_friends.sql ไปรันใน SQL Editor

# 2.2 ตั้ง secret ของ Edge Function
supabase secrets set \
  LINE_CHANNEL_SECRET="<channel secret จากขั้นที่ 1>" \
  LINE_CHANNEL_ACCESS_TOKEN="<channel access token จากขั้นที่ 1>"

# 2.3 deploy webhook (สำคัญ: ใส่ --no-verify-jwt เพราะ LINE ไม่ได้แนบ JWT มา)
supabase functions deploy line-webhook --no-verify-jwt
```

จะได้ URL ของ webhook หน้าตาแบบนี้:

```
https://<PROJECT_REF>.supabase.co/functions/v1/line-webhook
```

---

## ขั้นที่ 3 — ผูก Webhook กับ LINE

1. ที่ LINE Developers Console → channel → แท็บ **Messaging API → Webhook URL**
   - วาง URL จากขั้นที่ 2.3
   - กด **Verify** ควรขึ้น Success
   - เปิด **Use webhook = ON**
2. ลองเอามือถือ **เพิ่ม OA เป็นเพื่อน** → ควรได้ข้อความต้อนรับกลับมา และมีแถวเพิ่มในตาราง `line_friends` (เช็คได้ใน Supabase → Table Editor)

---

## ขั้นที่ 4 — ตั้งค่าให้ GitHub Actions ส่งตอนเช้า

ที่ repo บน GitHub → **Settings → Secrets and variables → Actions → New repository secret** เพิ่ม 3 ตัว:

| Secret | ค่า |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | channel access token (ตัวเดียวกับขั้นที่ 1) |
| `SUPABASE_URL` | `https://<PROJECT_REF>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (Supabase → Project Settings → API → `service_role`) |

> `service_role` เป็นคีย์ที่มีสิทธิ์เต็ม — ใส่เป็น GitHub Secret เท่านั้น อย่าวางในโค้ด

เสร็จแล้ว workflow `.github/workflows/line-morning.yml` จะรันอัตโนมัติ **ทุกวัน 23:00 UTC = 06:00 น. (ไทย)**

ทดสอบเลยได้โดยไม่ต้องรอเช้า: ไปที่แท็บ **Actions → LINE Morning Greeting → Run workflow**

---

## เกร็ดและการดูแล

- **ส่งทีละคน:** ใช้ LINE push API ยิงรายคน (ไม่ใช่ broadcast) ตามที่ต้องการ — เผื่ออนาคตอยากใส่ชื่อ/ปรับข้อความเฉพาะคน
- **คนบล็อก/ลบเพื่อน:** webhook จับ `unfollow` แล้วตั้ง `active=false` ให้เอง จะได้ไม่ส่งซ้ำ (ถ้าส่งไปโดน error ก็ข้ามคนนั้น ไม่ล้มทั้งรอบ)
- **เปลี่ยนเวลา/ข้อความ:** แก้ `cron` ใน `line-morning.yml` และข้อความใน `scripts/line_morning.mjs` (ฟังก์ชัน `composeText`)
- **โควตาข้อความ:** LINE OA แบบฟรีมีโควตา push ต่อเดือนจำกัด ถ้าเพื่อนเยอะให้ดูแพ็กเกจของ LINE OA
- **รูปของวัน:** หยิบจาก branch `daily-images` โฟลเดอร์วันนี้ (ตามเวลาไทย) ไม่มีก็ใช้ `evergreen` — เป็นรูปที่ baked ข้อความเสร็จแล้ว ส่งเป็นรูปได้เลย พร้อมแนบข้อความคำอวยพรอีกหนึ่งบับเบิล
