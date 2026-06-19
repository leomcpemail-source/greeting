-- รองรับฟีเจอร์ "ทำภาพสวัสดีจากรูปที่ user ส่งมา"
-- bucket สาธารณะเก็บภาพผลลัพธ์ (ส่งกลับทาง LINE แล้วลบทีหลังได้)
insert into storage.buckets (id, name, public) values ('usercards','usercards', true)
on conflict (id) do update set public = true;

-- จำรูปล่าสุดที่ user ส่งมา เพื่อใช้ตอนยืนยัน "ทำภาพสวัสดี"
create table if not exists public.line_photo_pending (
  user_id text primary key,
  message_id text not null,
  created_at timestamptz not null default now()
);
alter table public.line_photo_pending enable row level security;
-- เขียน/อ่านผ่าน service role (line-webhook) เท่านั้น ไม่เปิด policy ให้ anon
