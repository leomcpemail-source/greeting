-- LINE behavior stats: บันทึก "คำขอ/พฤติกรรม" ของ user ในแชต LINE (น้องใส่ใจ)
--   เช่น ขอทำภาพสวัสดีจากรูป (make_card) / ขอแก้คำอวยพร (edit_blessing) /
--        ขอรูปจากคลัง (get_image) / ส่งรูปเข้ามา (photo_upload) / พูดคุยทั่วไป (chat) / ชม-ขอบคุณ (ack)
-- โปรเจกต์ LINE (iuyiwpoupnuxnohpatyw) — แยกจากสถิติเว็บ
-- เขียนโดย edge function line-webhook ด้วย service role เท่านั้น (ไม่เปิด anon)
-- แยกตารางจาก line_events (คลิกเข้าเว็บ) เพื่อไม่ให้สถิติคลิกเพี้ยน

create table if not exists public.line_intents (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  action text not null,   -- make_card | edit_blessing | get_image | photo_upload | chat | ack
  cat text                -- หมวดรูปที่ขอ (เฉพาะ get_image) ไม่มี = null
);
create index if not exists line_intents_ts_idx on public.line_intents(ts);
alter table public.line_intents enable row level security;
-- ไม่เปิด policy ให้ anon: insert ทำผ่าน service role (line-webhook) เท่านั้น

-- ── อัปเดต RPC line_stats: เพิ่มก้อน "behaviors" (สรุปคำขอในแชต) สำหรับ treemap ใน db.html ──
create or replace function public.line_stats(p_token text, p_days int default 36500, p_date text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text := 'lstat_9f3c1ab27e5d4';
  tz   text := 'Asia/Bangkok';
  today date := (now() at time zone tz)::date;
  is_day boolean := p_date is not null;
  d0 date;
  d1 date;
  win0 date;
  result json;
begin
  if p_token is distinct from v_secret then
    return json_build_object('error','unauthorized');
  end if;

  if is_day then
    d0 := p_date::date; d1 := p_date::date;
  else
    d1 := today;
    d0 := today - (greatest(p_days,1) - 1);
  end if;
  win0 := case when is_day then d0 else greatest(d0, today - 89) end;

  select json_build_object(
    'generated_at', now(),
    'tz', tz,
    'is_day_mode', is_day,
    'target_date', case when is_day then p_date else null end,
    'range_days', p_days,
    'today', today,
    'friends', (
      select json_build_object(
        'active_now',   count(*) filter (where active),
        'total_ever',   count(*),
        'new_today',    count(*) filter (where (followed_at   at time zone tz)::date = today),
        'left_today',   count(*) filter (where (unfollowed_at at time zone tz)::date = today),
        'sent_today',   count(*) filter (where (last_sent_at  at time zone tz)::date = today),
        'new_in_range', count(*) filter (where (followed_at   at time zone tz)::date between d0 and d1),
        'left_in_range',count(*) filter (where (unfollowed_at at time zone tz)::date between d0 and d1)
      ) from line_friends
    ),
    'by_day', (
      with span as (select generate_series(win0, d1, interval '1 day')::date as day)
      select coalesce(json_agg(json_build_object(
        'day', to_char(s.day,'YYYY-MM-DD'),
        'joins', coalesce(j.n,0),
        'leaves', coalesce(l.n,0),
        'net', coalesce(j.n,0) - coalesce(l.n,0)
      ) order by s.day), '[]'::json)
      from span s
      left join (select (followed_at   at time zone tz)::date d, count(*) n from line_friends where followed_at   is not null group by 1) j on j.d = s.day
      left join (select (unfollowed_at at time zone tz)::date d, count(*) n from line_friends where unfollowed_at is not null group by 1) l on l.d = s.day
    ),
    'clicks', (
      select json_build_object(
        'today',    count(*) filter (where (ts at time zone tz)::date = today),
        'in_range', count(*) filter (where (ts at time zone tz)::date between d0 and d1),
        'total',    count(*),
        'by_source', (select coalesce(json_agg(json_build_object('source',coalesce(source,'?'),'n',n) order by n desc),'[]'::json)
                      from (select source, count(*) n from line_events where (ts at time zone tz)::date between d0 and d1 group by source) q),
        'by_cat', (select coalesce(json_agg(json_build_object('cat',coalesce(cat,'?'),'n',n) order by n desc),'[]'::json)
                   from (select cat, count(*) n from line_events where (ts at time zone tz)::date between d0 and d1 and cat is not null group by cat) q)
      ) from line_events
    ),
    'by_day_clicks', (
      with span as (select generate_series(win0, d1, interval '1 day')::date as day)
      select coalesce(json_agg(json_build_object('day',to_char(s.day,'YYYY-MM-DD'),'n',coalesce(c.n,0)) order by s.day),'[]'::json)
      from span s
      left join (select (ts at time zone tz)::date d, count(*) n from line_events group by 1) c on c.d = s.day
    ),
    'behaviors', (
      select json_build_object(
        'today',    count(*) filter (where (ts at time zone tz)::date = today),
        'in_range', count(*) filter (where (ts at time zone tz)::date between d0 and d1),
        'total',    count(*),
        'by_action', (select coalesce(json_agg(json_build_object('action',coalesce(action,'?'),'n',n) order by n desc),'[]'::json)
                      from (select action, count(*) n from line_intents where (ts at time zone tz)::date between d0 and d1 group by action) q),
        'by_cat', (select coalesce(json_agg(json_build_object('cat',coalesce(cat,'?'),'n',n) order by n desc),'[]'::json)
                   from (select cat, count(*) n from line_intents where (ts at time zone tz)::date between d0 and d1 and cat is not null group by cat) q)
      ) from line_intents
    )
  ) into result;

  return result;
end;
$$;

grant execute on function public.line_stats(text,int,text) to anon, authenticated;
