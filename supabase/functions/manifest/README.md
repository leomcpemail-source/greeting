# Edge Function: `manifest` (origin gate)

ทำหน้าที่กันไม่ให้เว็บที่ถูก clone ไป deploy บนโดเมนอื่นใช้งานได้ โดยเช็ค `Origin`
ของคำขอฝั่ง server แล้วส่ง manifest จริงให้เฉพาะโดเมนจริงเท่านั้น โดเมนอื่นได้ `{}` เปล่า
→ หน้าเว็บของคนที่ลอกไป "ว่าง ไม่มีรูป" โดยไม่มี error ชัดในคอนโซล (logic อยู่ฝั่ง server
ทั้งหมด มองไม่เห็นจากโค้ด client)

## โดเมนที่อนุญาต
แก้ที่ตัวแปร `ALLOW_EXACT` ใน `index.ts` (ตอนนี้ตั้งไว้ `https://leomcpemail-source.github.io`
+ localhost สำหรับ dev) แล้ว deploy ใหม่ทุกครั้งที่แก้

## วิธี deploy (ทำครั้งเดียว / ทุกครั้งที่แก้ index.ts)

```bash
# 1) ติดตั้ง Supabase CLI ถ้ายังไม่มี  (เช่น: brew install supabase/tap/supabase)
# 2) ล็อกอิน
supabase login

# 3) ผูกกับโปรเจกต์ (project ref จาก SB_URL: bbtmcwydwscjjoxydbfp)
supabase link --project-ref bbtmcwydwscjjoxydbfp

# 4) deploy
supabase functions deploy manifest
```

> หมายเหตุ: ฝั่ง client (`index.html`) ส่ง anon key มาใน header `apikey`/`Authorization`
> อยู่แล้ว จึงผ่านการตรวจ JWT แบบ default ของ Edge Functions ได้ — ไม่ต้องใช้ flag
> `--no-verify-jwt`

## ทดสอบหลัง deploy

```bash
# โดเมนจริง -> ได้ manifest จริง (หรือ 404 ถ้าไฟล์วันนั้นยังไม่ถูก gen)
curl -i 'https://bbtmcwydwscjjoxydbfp.supabase.co/functions/v1/manifest?path=img/evergreen/manifest.json' \
  -H 'Origin: https://leomcpemail-source.github.io' \
  -H 'apikey: <ANON_KEY>'

# โดเมนปลอม (เลียนแบบเว็บที่ลอกไป) -> ได้ {} เปล่า สถานะ 200
curl -i 'https://bbtmcwydwscjjoxydbfp.supabase.co/functions/v1/manifest?path=img/evergreen/manifest.json' \
  -H 'Origin: https://someone-else.github.io' \
  -H 'apikey: <ANON_KEY>'
```

## ขอบเขต / ข้อจำกัด
- รูปภาพแต่ละไฟล์ยังอยู่บน `raw.githubusercontent.com` (สาธารณะ) แต่ถ้าไม่มี manifest
  เว็บที่ลอกไปจะไม่รู้ว่าต้องโหลดไฟล์ไหน/จัดวางยังไง → หน้าว่าง
- กันเว็บที่ลอกไป deploy บน browser (โดเมนอื่น) ได้ดี แต่ผู้ที่ตั้งใจใช้ `curl` แล้วปลอม
  header `Origin` ยังเลี่ยงได้ — เป็นข้อจำกัดของเว็บ static สาธารณะที่เลี่ยงไม่ได้ 100%
