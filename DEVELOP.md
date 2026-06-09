# คู่มือการพัฒนา — แยก "หน้าที่ user ใช้" ออกจาก "หน้าที่กำลังแก้"

## ปัญหาที่แก้
ก่อนหน้านี้ dev กับ user ใช้ `index.html` ไฟล์เดียวกัน พอแก้โค้ดเพื่อหา bug
user ที่เปิดเข้ามาตอนนั้นก็เจอหน้าพัง ทำให้เสียความประทับใจ

## วิธีแก้ — ใช้ 2 branch (มาตรฐานอุตสาหกรรม: production / development)

```
main   ← "ร้านที่เปิดขายจริง" — GitHub Pages serve จาก branch นี้เท่านั้น
         user เห็นหน้านี้ ต้องนิ่งและพร้อมเสมอ ห้ามแก้ตรง ๆ

dev    ← "หลังร้าน" — แก้ ทดลอง หา bug ที่นี่ได้เต็มที่
         user ไม่เห็น branch นี้
```

**กฎเหล็ก:** อย่าแก้ `index.html` บน `main` โดยตรง แก้บน `dev` เสมอ

---

## ขั้นตอนการทำงานประจำวัน

### 1. ไปที่ branch dev แล้วแก้
```bash
git checkout dev
git pull origin dev
# ...แก้ index.html / scripts ตามต้องการ...
git add -A && git commit -m "ลองปรับ layout การ์ด"
git push origin dev
```

### 2. Preview หน้า dev โดยไม่กระทบ user

**วิธี A — เปิดบนเครื่องตัวเอง (แม่นยำสุด แนะนำสำหรับเทสจริง):**
```bash
git checkout dev
python3 -m http.server 8080     # หรือ  npx serve
# เปิดเบราว์เซอร์ที่ http://localhost:8080
```

**วิธี B — เปิดผ่านเว็บเลย (ดูเร็ว ๆ ไม่ต้อง clone):**
เปิดลิงก์นี้ (มันคือ index.html บน branch dev โดยตรง):
```
https://htmlpreview.github.io/?https://raw.githubusercontent.com/leomcpemail-source/greeting/dev/index.html
```
> หมายเหตุ: วิธี B โหลดรูป/manifest จริงจาก branch `daily-images` ได้ปกติ
> เหมาะกับเช็คหน้าตา/ข้อความ ส่วนการเทสปุ่ม/แชร์ ให้ใช้วิธี A

### 3. พอพร้อมแล้ว — "สั่งให้หน้าจริงเปลี่ยน" (promote dev → main)

แนะนำให้ผ่าน Pull Request (จะได้เห็น diff + เก็บประวัติ):
```bash
# สร้าง PR จาก dev เข้า main บนหน้าเว็บ GitHub
#   Compare & pull request → base: main ← compare: dev → Merge
```
หรือถ้ามั่นใจแล้วจะ merge ตรงก็ได้:
```bash
git checkout main
git merge dev
git push origin main      # ← วินาทีนี้แหละที่ user เริ่มเห็นของใหม่
```

GitHub Pages จะ rebuild อัตโนมัติภายใน ~1 นาที user ถึงจะเห็นเวอร์ชันใหม่

---

## เกี่ยวกับ pipeline สร้างรูป (สำคัญ)

GitHub Actions (`.github/workflows/daily.yml`) ดึงโค้ดเรนเดอร์จาก
**`index.html` บน branch `main` เท่านั้น** แล้ว bake ข้อความลงรูป

แปลว่า:
- ถ้าแก้ **เฉพาะหน้าตา/JS ฝั่ง browser** บน `dev` → preview ได้เลย ไม่กระทบรูป
- ถ้าแก้ **โค้ดที่ใช้ bake รูป** (เช่น `buildCard`, `FRAMES`, `LAYOUTS`)
  รูปจริงจะยังใช้สูตรของ `main` จนกว่าจะ merge เข้า main แล้วรอบ gen รอบถัดไปทำงาน
  → เทสประเภทนี้ให้ดูที่เครื่องตัวเอง แล้ว merge เมื่อมั่นใจ

---

## สรุปสั้น ๆ
| อยากทำอะไร | ทำที่ไหน |
|---|---|
| แก้โค้ด ทดลอง หา bug | branch `dev` |
| ให้ user เห็นของใหม่ | merge `dev` → `main` |
| ดูหน้า dev ก่อน | localhost หรือ htmlpreview |
| ห้ามเด็ดขาด | แก้ `index.html` ตรง ๆ บน `main` |
