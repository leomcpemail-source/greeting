# Deploy ของ line-webhook (loader pattern)

ฟังก์ชันจริงบน Supabase = "tiny loader" ที่ฝัง secrets ลง `globalThis.__SEC`
แล้ว `import` โค้ดหลัก (`index.ts`) จาก repo ที่ pin ด้วย commit SHA — ทำให้
ไม่ต้อง paste โค้ดยาว ๆ ทุกครั้งที่แก้ (push repo + redeploy loader สั้น ๆ พอ)

> หมายเหตุ: ใช้ `globalThis.__SEC` แทน `Deno.env.set` เพราะ edge runtime
> ไม่อนุญาตให้เขียน env (Deno.env.set จะทำให้ฟังก์ชัน 500)

ตัว loader (เนื้อหาไฟล์ index.ts ที่ deploy จริง) — แก้ `<SHA>` เป็น commit ล่าสุดของ main:

```ts
(globalThis as any).__SEC = {
  AT: "<LINE_CHANNEL_ACCESS_TOKEN>",
  TK: "<THAILLM_API_KEY>",
  MK: "<MKCARD_TOKEN>",
};
await import("https://raw.githubusercontent.com/leomcpemail-source/greeting/<SHA>/supabase/functions/line-webhook/index.ts");
```

ขั้นตอน deploy:
1. แก้ `index.ts` (core) → push ขึ้น main
2. นำ commit SHA ของ main มาใส่ใน loader ข้างบน
3. deploy ฟังก์ชัน `line-webhook` ด้วยเนื้อหา loader (verify_jwt = false)

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` แพลตฟอร์มใส่ให้เป็น env อยู่แล้ว
จึงไม่ต้องอยู่ใน `__SEC` (core มี fallback ให้)
