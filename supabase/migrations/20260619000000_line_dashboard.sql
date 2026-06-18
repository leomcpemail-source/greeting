-- LINE dashboard: ตารางคลิก + RPC สถิติ/รายชื่อเพื่อน สำหรับ db.html
-- โปรเจกต์ LINE (iuyiwpoupnuxnohpatyw) — แยกจากสถิติเว็บ
-- token ในไฟล์นี้ตรงกับค่าใน db.html (LINE_STATS_TOKEN / LINE_ADMIN_TOKEN)

-- ── ตารางเก็บคลิกจาก LINE → เว็บ (เขียนโดย edge function line-go ด้วย service role) ──
create table if not exists public.line_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  kind text not null default 'click',
  source text,
  cat text
);
create index if not exists line_events_ts_idx on public.line_events(ts);
alter table public.line_events enable row level security;
-- ไม่เปิด policy ให้ anon: insert ทำผ่าน service role (line-go) เท่านั้น

-- ── RPC สรุปสถิติ LINE (read-only, คืนเฉพาะตัวเลขรวม ไม่มี PII) ──
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
    )
  ) into result;

  return result;
end;
$$;

grant execute on function public.line_stats(text,int,text) to anon, authenticated;

-- ── RPC รายชื่อเพื่อน (ต้องใช้ admin token) สำหรับเลือกยิงทดสอบใน db.html ──
create or replace function public.line_friends_list(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text := 'ladmin_4b8e2f1c9a7';
begin
  if p_token is distinct from v_admin then
    return json_build_object('error','unauthorized');
  end if;
  return coalesce((
    select json_agg(json_build_object(
      'user_id', user_id,
      'name', display_name,
      'active', active,
      'followed_at', followed_at,
      'last_sent_at', last_sent_at
    ) order by followed_at desc nulls last)
    from line_friends
  ), '[]'::json);
end;
$$;

grant execute on function public.line_friends_list(text) to anon, authenticated;
