# รูป Rich Menu ของ LINE

รูปต้นฉบับของเมนู (ติดตั้งเข้า LINE แล้ว — ดู `../../LINE_SETUP.md` ขั้นที่ 5):

- `main.jpg`        — เมนูหลัก (ซ้าย "หน้าแรก" / ขวา "ตามหมวด")
- `categories.jpg`  — เมนูหมวดหมู่ (แถบ "‹ กลับ" + กริด 4×3 = 12 หมวด)

อัตราส่วนแนะนำ ~2.97:1 (เช่น 2500×843) — Edge Function `line-richmenu-install`
จะ resize เป็น 2500×843 ให้อัตโนมัติแล้วอัปโหลดเข้า LINE

เปลี่ยนรูป: แทนไฟล์ที่นี่ → commit → เรียกฟังก์ชัน `line-richmenu-install` อีกครั้ง (ดูคำสั่ง SQL ใน LINE_SETUP.md)
