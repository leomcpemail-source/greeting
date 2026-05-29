# Daily Greeting Bot ☀️

สร้างรูปสวัสดีประจำวันแบบไทยอัตโนมัติ — gen 30 รูปตอนดึก (ตามสีประจำวัน + กรองรูปแปลกออกด้วย AI) แล้วเปิดดู/เลือก/ดาวน์โหลดตอนเช้า

## โครงสร้าง

```
.github/workflows/daily.yml   ← cron ตี 0:15 ไทย (รันเองได้ด้วย)
scripts/generate.mjs          ← gen รูป + กรอง + จัดการคลังคำอวยพร
index.html                    ← หน้าเว็บตอนเช้า
blessings.seed.json           ← คลังคำอวยพรเริ่มต้น
```

## วิธีติดตั้ง (ครั้งเดียว)

1. **สร้างรีโปใหม่** บน GitHub (เช่น `daily-greeting`) แล้วอัปไฟล์ทั้งหมดนี้ขึ้น branch `main` (ลากวางผ่านเว็บได้เลย แต่ `.github/workflows/daily.yml` ต้องอยู่ในโฟลเดอร์ตามนี้)

2. **แก้ `index.html`** บรรทัด:
   ```js
   const REPO = "leomcpemail-source/REPO_NAME";  // ⬅️ ใส่ user/ชื่อรีโปจริง
   ```

3. **เปิด GitHub Pages**: Settings → Pages → Source = `main` / root

4. **ให้สิทธิ์ Actions เขียนรีโป**: Settings → Actions → General → Workflow permissions → เลือก **Read and write permissions**

5. **รันรอบแรกเอง**: แท็บ **Actions** → *Daily Greeting Generation* → **Run workflow**
   (ใช้เวลา ~20-40 นาที เพราะเว้นโควต้า Pollinations 16 วิ/รูป)

6. เสร็จแล้วเปิดหน้าเว็บ Pages ได้เลย → จะเห็นรูปของวันนี้

## การทำงานอัตโนมัติ

- ทุกวัน **00:15 น. ไทย** workflow จะ gen 30 รูปของวันนั้น เก็บไว้ที่ branch `daily-images` (commit เดียว force-push → ประวัติไม่บวม)
- คลังคำอวยพรหมุนไม่ซ้ำในรอบ 30 วัน ถ้าจะหมดให้ AI แต่งเพิ่มเอง

## ปรับแต่งได้ใน `scripts/generate.mjs`

| ตัวแปร | ค่า | ความหมาย |
|---|---|---|
| `TARGET` | 30 | จำนวนรูปต่อวัน |
| `SLEEP_MS` | 16000 | เว้นห่างต่อ request (กันชนโควต้า) |
| `VISION` | true | เปิด/ปิดการกรองรูปอัตโนมัติ |
| `REUSE_AFTER_DAYS` | 30 | คำอวยพรเว้นซ้ำกี่วัน |
| `DAYS[].flower` | - | เปลี่ยนดอกไม้ของแต่ละวัน |

## หมายเหตุ

- ปุ่มดาวน์โหลด/คัดลอกทำงานได้เพราะรูปมาจาก raw.githubusercontent (มี CORS) ต่างจากการดึงสดจาก Pollinations
- GitHub Actions cron อาจดีเลย์ 10-30 นาที แต่มี buffer ถึงตี 4 จึงไม่กระทบ
- หากไม่ activity เกิน 60 วัน GitHub จะหยุด cron อัตโนมัติ (เข้าไปกด enable ใหม่ได้)

## ก้าวต่อไป (ยังไม่ทำในเวอร์ชันนี้)

ส่งเข้า LINE อัตโนมัติด้วย **LINE Messaging API** (push image) — ต้องมี LINE Official Account + Channel Access Token แล้วให้ workflow push รูปที่เลือกไว้ตอนเช้า
