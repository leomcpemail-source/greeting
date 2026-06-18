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

## ขั้นที่ 2 — หลังบ้านบน Supabase ✅ (ติดตั้งให้แล้ว)

ติดตั้งให้เรียบร้อยแล้วบนโปรเจกต์ Supabase **`iuyiwpoupnuxnohpatyw`**:
- ✅ สร้างตาราง `line_friends` (เปิด RLS — เข้าถึงเฉพาะ service role)
- ✅ deploy Edge Function `line-webhook` (ปิด verify_jwt แล้ว)

**Webhook URL** (ใช้ในขั้นที่ 3):
```
https://iuyiwpoupnuxnohpatyw.supabase.co/functions/v1/line-webhook
```

> หมายเหตุ: โปรเจกต์นี้ใช้ร่วมกับแอพอื่น (workplace-planner) แต่ตาราง/ฟังก์ชันของ LINE แยกอิสระ ไม่กระทบกัน ถ้าภายหลังอยากย้ายไปโปรเจกต์ของเว็บ (`bbtmcwydwscjjoxydbfp`) บอกได้ เดี๋ยวย้ายให้

**สิ่งเดียวที่เหลือ:** เมื่อได้ token จากขั้นที่ 1 แล้ว ตั้ง secret 2 ตัวให้ Edge Function — ผ่าน Dashboard (**Edge Functions → line-webhook → Secrets / Manage secrets**) หรือ CLI:

```bash
supabase link --project-ref iuyiwpoupnuxnohpatyw
supabase secrets set \
  LINE_CHANNEL_SECRET="<channel secret จากขั้นที่ 1>" \
  LINE_CHANNEL_ACCESS_TOKEN="<channel access token จากขั้นที่ 1>"
```

> ถ้ายังไม่ตั้ง secret: webhook จะตอบ 401 ทุก request (เพราะตรวจลายเซ็นไม่ผ่าน) — ตั้งให้ครบก่อนกด Verify ในขั้นที่ 3

---

## ขั้นที่ 3 — ผูก Webhook กับ LINE

1. ที่ LINE Developers Console → channel → แท็บ **Messaging API → Webhook URL**
   - วาง URL จากขั้นที่ 2
   - กด **Verify** ควรขึ้น Success
   - เปิด **Use webhook = ON**
2. ลองเอามือถือ **เพิ่ม OA เป็นเพื่อน** → ควรได้ข้อความต้อนรับกลับมา และมีแถวเพิ่มในตาราง `line_friends` (เช็คได้ใน Supabase → Table Editor)

---

## ขั้นที่ 4 — ตั้งค่าให้ GitHub Actions ส่งตอนเช้า

ที่ repo บน GitHub → **Settings → Secrets and variables → Actions → New repository secret** เพิ่ม 3 ตัว:

| Secret | ค่า |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | channel access token (ตัวเดียวกับขั้นที่ 1) |
| `SUPABASE_URL` | `https://iuyiwpoupnuxnohpatyw.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key ของโปรเจกต์ `iuyiwpoupnuxnohpatyw` (Supabase → Project Settings → API → `service_role`) |

> `service_role` เป็นคีย์ที่มีสิทธิ์เต็ม — ใส่เป็น GitHub Secret เท่านั้น อย่าวางในโค้ด

เสร็จแล้ว workflow `.github/workflows/line-morning.yml` จะรันอัตโนมัติ **ทุกวัน 23:00 UTC = 06:00 น. (ไทย)**

ทดสอบเลยได้โดยไม่ต้องรอเช้า: ไปที่แท็บ **Actions → LINE Morning Greeting → Run workflow**

---

## ขั้นที่ 5 — เมนู (Rich Menu) ให้เลือกรูป "หน้าแรก / ตามหมวด" เหมือนในเว็บ

เมนูมี 2 ระดับ (ใช้ฟีเจอร์ *rich menu switch* ของ LINE):

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

> เว็บรองรับ deep-link `?cat=<id>` แล้ว (เพิ่มแบบไม่กระทบของเดิม) — เปิด `…/greeting/?cat=flowers` จะเด้งเข้าหมวดดอกไม้ทันที

### 5.1 เตรียมรูป 2 ไฟล์ (ให้ ChatGPT ช่วยวาดได้)

ทั้งสองรูปขนาด **2500 × 1686 px**, PNG/JPEG, ไฟล์ **≤ 1 MB** และต้องวาง "ช่อง" ให้ตรงพิกัดนี้เป๊ะ (ไม่งั้นจุดกดจะเลื่อน):

**รูปที่ 1 — เมนูหลัก** (`assets/richmenu/main.png`): แบ่งซ้าย-ขวาที่ x = 1250
- ครึ่งซ้าย (0–1250) = ปุ่ม **"หน้าแรก"** (เช่น ไอคอน ☀️ "รูปสวัสดีวันนี้")
- ครึ่งขวา (1250–2500) = ปุ่ม **"ตามหมวด"** (เช่น ไอคอน 🗂️ "เลือกตามหมวด")

**รูปที่ 2 — เมนูหมวดหมู่** (`assets/richmenu/categories.png`):
- แถบบนสุด (y 0–230, เต็มกว้าง) = ปุ่ม **"‹ กลับ"**
- ด้านล่าง = กริด **4 คอลัมน์ × 3 แถว** (แต่ละช่องกว้าง 625, สูง 485) เรียงซ้าย→ขวา บน→ล่าง:

| | คอลัมน์ 1 | คอลัมน์ 2 | คอลัมน์ 3 | คอลัมน์ 4 |
|---|---|---|---|---|
| แถว 1 | 🌸 ดอกไม้ | 🪷 ธรรมะ | ❤️ กำลังใจ | 💌 คิดถึง |
| แถว 2 | 🎂 วันเกิด | 👴 ผู้สูงวัย | ➕ สุขภาพ | ⭐ เทศกาล |
| แถว 3 | 🏠 ครอบครัว | 🐾 สัตว์เลี้ยง | ☕ กาแฟยามเช้า | 🏔️ วิวธรรมชาติ |

> พรอมต์สั้น ๆ สำหรับ ChatGPT/วาดรูป: *"LINE rich menu 2500×1686, กริด 4 คอลัมน์ 3 แถว มีแถบหัวด้านบนเขียน ‹ กลับ, แต่ละช่องมีไอคอนกับชื่อหมวดตามตารางนี้, สไตล์การ์ตูนน่ารักโทนพาสเทล เส้นแบ่งช่องชัดเจน"* แล้วบอกให้วางช่องตามพิกัดข้างบน

### 5.2 ติดตั้งเมนู

เอารูปใส่ไว้ที่ `assets/richmenu/main.png` กับ `assets/richmenu/categories.png` แล้ว commit เข้า repo จากนั้นเลือกวิธีใดวิธีหนึ่ง:

- **ผ่าน GitHub Actions (ง่ายสุด):** ใส่ secret `LINE_CHANNEL_ACCESS_TOKEN` (มีอยู่แล้วจากขั้นที่ 4) → ไปแท็บ **Actions → LINE Rich Menu Install → Run workflow**
- **รันในเครื่อง:**
  ```bash
  LINE_CHANNEL_ACCESS_TOKEN="<token>" node scripts/line_richmenu.mjs
  # หรือระบุ path รูปเอง: node scripts/line_richmenu.mjs path/main.png path/categories.png
  ```

สคริปต์จะลบเมนูเดิม สร้างเมนูใหม่ทั้งสองระดับ ผูกปุ่มสลับเมนู และตั้งเมนูหลักเป็น default ให้อัตโนมัติ (รันซ้ำได้เรื่อย ๆ เวลาเปลี่ยนรูป)

> ถ้า URL เว็บแอพไม่ใช่ `https://leomcpemail-source.github.io/greeting/` ให้ตั้ง repository variable `APP_URL` (Settings → Secrets and variables → Actions → Variables) หรือ ENV `APP_URL` ตอนรันในเครื่อง

---

## เกร็ดและการดูแล

- **ส่งทีละคน:** ใช้ LINE push API ยิงรายคน (ไม่ใช่ broadcast) ตามที่ต้องการ — เผื่ออนาคตอยากใส่ชื่อ/ปรับข้อความเฉพาะคน
- **คนบล็อก/ลบเพื่อน:** webhook จับ `unfollow` แล้วตั้ง `active=false` ให้เอง จะได้ไม่ส่งซ้ำ (ถ้าส่งไปโดน error ก็ข้ามคนนั้น ไม่ล้มทั้งรอบ)
- **เปลี่ยนเวลา/ข้อความ:** แก้ `cron` ใน `line-morning.yml` และข้อความใน `scripts/line_morning.mjs` (ฟังก์ชัน `composeText`)
- **โควตาข้อความ:** LINE OA แบบฟรีมีโควตา push ต่อเดือนจำกัด ถ้าเพื่อนเยอะให้ดูแพ็กเกจของ LINE OA
- **รูปของวัน:** หยิบจาก branch `daily-images` โฟลเดอร์วันนี้ (ตามเวลาไทย) ไม่มีก็ใช้ `evergreen` — เป็นรูปที่ baked ข้อความเสร็จแล้ว ส่งเป็นรูปได้เลย พร้อมแนบข้อความคำอวยพรอีกหนึ่งบับเบิล
