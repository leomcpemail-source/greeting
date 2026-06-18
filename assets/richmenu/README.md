# รูป Rich Menu ของ LINE

วางรูป 2 ไฟล์ตรงนี้ (ดูสเปก/พิกัดช่องกดใน `../../LINE_SETUP.md` ขั้นที่ 5):

- `main.png`        — เมนูหลัก (ซ้าย "หน้าแรก" / ขวา "ตามหมวด"), 2500×1686, ≤1MB
- `categories.png`  — เมนูหมวดหมู่ (แถบ "‹ กลับ" + กริด 4×3 = 12 หมวด), 2500×1686, ≤1MB

ติดตั้งด้วย: `node scripts/line_richmenu.mjs` (ต้องมี ENV `LINE_CHANNEL_ACCESS_TOKEN`)
หรือผ่าน GitHub Actions: **LINE Rich Menu Install → Run workflow**
