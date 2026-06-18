-- ตาราง "เพื่อน" ของ LINE Official Account
-- เก็บ userId ของคนที่กดเพิ่มเพื่อน เพื่อให้ตัวส่งตอนเช้ายิงข้อความหาทีละคนได้
--
-- เขียน/อ่านโดย:
--   • Edge Function line-webhook  (service role → เพิ่ม/ปิด เพื่อน)
--   • GitHub Actions line-morning (service role → อ่านรายชื่อ active เพื่อส่งตอนเช้า)
-- เปิด RLS แต่ไม่สร้าง policy ใด ๆ → เข้าถึงได้เฉพาะ service role (ซึ่ง bypass RLS) เท่านั้น
-- กันไม่ให้ anon key (ที่ฝังอยู่ในหน้าเว็บ) อ่าน userId ของเพื่อนได้

create table if not exists public.line_friends (
  user_id        text primary key,                 -- LINE userId (U....)
  display_name   text,                              -- ชื่อโปรไฟล์ตอนกดเพิ่มเพื่อน (อาจว่างได้)
  active         boolean     not null default true, -- false = บล็อก/ลบเพื่อนแล้ว → ไม่ส่ง
  followed_at    timestamptz not null default now(),
  unfollowed_at  timestamptz,
  last_sent_at   timestamptz                        -- ส่งคำอวยพรครั้งล่าสุดเมื่อไหร่
);

-- ดึงเฉพาะเพื่อนที่ยัง active ตอนส่งตอนเช้า → ทำ index ช่วย
create index if not exists line_friends_active_idx
  on public.line_friends (active)
  where active = true;

alter table public.line_friends enable row level security;
