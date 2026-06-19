-- รองรับการถาม user เมื่อมี "ภาพเดิมค้างอยู่" แล้วส่งรูปใหม่/กดเมนูเข้ามาอีก (ภายในกรอบ 5 นาที)
-- staged_message_id: รูป/คำขอใหม่ที่พักไว้รอ user ตัดสินใจ ("ทำใหม่" หรือ "ใช้ภาพเดิม")
--   ค่า '-' = กดเมนู (ยังไม่มีรูปใหม่) ; เป็น message id = ส่งรูปใหม่เข้ามาระหว่างมีภาพเดิม
alter table public.line_photo_pending add column if not exists staged_message_id text;
alter table public.line_photo_pending add column if not exists staged_at timestamptz;
