-- refs-schema.sql — รันใน Supabase SQL Editor ครั้งเดียว (มิ.ย. 2569)
-- ตาราง + RPC สำหรับ "ภาพต้นแบบ (refs)" — ภาพสวัสดีที่คนนิยมส่งต่อกันจริง ที่เจ้าของคัดมา
-- ใช้สอนระบบเรียนรู้ (LEARNING-PLAN.md Phase 0a): pipeline ดึงไปคิด CLIP similarity
-- จัดการผ่านหน้า db.html (อัปโหลด/ดู/ลบ) — ไม่ต้องเข้า GitHub
--
-- ความปลอดภัย: ตารางเปิด RLS แต่ "ไม่มี policy" = anon แตะตรงๆ ไม่ได้เลย
-- ทุกอย่างผ่าน RPC (security definer) ที่เช็ค secret ก่อนเสมอ
--
-- ⚠️ แก้บรรทัด secret ทั้ง 3 ฟังก์ชันให้ตรงรหัสผ่าน dashboard เดิมก่อนรัน (เหมือน analytics-schema-v2)

create table if not exists public.refs (
  id          bigint generated always as identity primary key,
  name        text,
  img         text not null,          -- data URL jpeg ย่อแล้ว (~512px, ~50-100KB)
  created_at  timestamptz default now()
);
alter table public.refs enable row level security;

-- รายการ refs ทั้งหมด (รวมตัวรูป — รูปเล็กพอที่จะส่งทั้งก้อน)
create or replace function public.refs_list(pass text)
returns json language plpgsql security definer set search_path = public as $$
declare secret text := 'CHANGE_ME';
begin
  if pass is distinct from secret then return json_build_object('error','unauthorized'); end if;
  return coalesce((select json_agg(json_build_object('id',id,'name',name,'img',img,'t',to_char(created_at at time zone 'Asia/Bangkok','MM-DD')) order by id desc) from refs), '[]'::json);
end; $$;

-- เพิ่มภาพ (จำกัด: jpeg data URL, ไม่เกิน ~440KB, รวมไม่เกิน 100 ใบ)
create or replace function public.refs_add(pass text, p_name text, p_img text)
returns json language plpgsql security definer set search_path = public as $$
declare secret text := 'CHANGE_ME'; new_id bigint;
begin
  if pass is distinct from secret then return json_build_object('error','unauthorized'); end if;
  if p_img is null or p_img not like 'data:image/jpeg;base64,%' then return json_build_object('error','bad_format'); end if;
  if length(p_img) > 600000 then return json_build_object('error','too_big'); end if;
  if (select count(*) from refs) >= 100 then return json_build_object('error','full'); end if;
  insert into refs(name, img) values (left(coalesce(p_name,''),80), p_img) returning id into new_id;
  return json_build_object('ok',true,'id',new_id);
end; $$;

-- ลบภาพ
create or replace function public.refs_del(pass text, p_id bigint)
returns json language plpgsql security definer set search_path = public as $$
declare secret text := 'CHANGE_ME';
begin
  if pass is distinct from secret then return json_build_object('error','unauthorized'); end if;
  delete from refs where id = p_id;
  return json_build_object('ok',true);
end; $$;

revoke all on function public.refs_list(text) from public;
revoke all on function public.refs_add(text, text, text) from public;
revoke all on function public.refs_del(text, bigint) from public;
grant execute on function public.refs_list(text) to anon;
grant execute on function public.refs_add(text, text, text) to anon;
grant execute on function public.refs_del(text, bigint) to anon;
