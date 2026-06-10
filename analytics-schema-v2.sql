-- analytics-schema-v2.sql — รันใน Supabase SQL Editor ครั้งเดียว (มิ.ย. 2569)
-- เพิ่ม RPC ใหม่ dashboard_stats2 (ของเดิม dashboard_stats ไม่ถูกแตะ — db.html จะ fallback ไปใช้ของเดิมถ้ายังไม่รันไฟล์นี้)
--
-- ของใหม่ใน v2:
--   1. totals.approx_devices  = "เครื่องโดยประมาณ" นับจาก fingerprint (ua+ภาษา+timezone)
--      → ผู้ใช้เปิด incognito จะถูกนับรวมเป็นเครื่องเดียวกับ browser ปกติ (visitor_id ใน localStorage นับแยก)
--   2. by_day_actions          = เปิดใช้/ดาวน์โหลด/คัดลอก รายวัน (กราฟวิเคราะห์โหลดเว็บ)
--   3. pipeline                = สถิติการ gen รูปจาก GitHub Actions (generate.mjs ส่ง event visitor_id='pipeline')
--      keeps/rejects/avg_score/by_day/by_cat/runs — ดูได้ใน db.html ไม่ต้องเปิด GitHub
--   4. user stats ทุกตัว "ไม่นับ" แถวของ pipeline (visitor_id='pipeline') — แยกขาดจากสถิติคน
--
-- ⚠️ แก้บรรทัด secret ให้ตรงกับรหัสผ่านเดิมใน dashboard_stats ก่อนรัน

create or replace function public.dashboard_stats2(pass text, days int default 7, target_date text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  secret  text := 'CHANGE_ME';   -- ⚠️ ใส่รหัสเดียวกับ dashboard_stats เดิม
  t_start timestamptz;
  t_end   timestamptz;
  result  json;
begin
  if pass is distinct from secret then
    return json_build_object('error','unauthorized');
  end if;

  if target_date is not null then
    t_start := (target_date || ' 00:00:00+07')::timestamptz;
    t_end   := t_start + interval '1 day';
  else
    t_start := now() - make_interval(days => days);
    t_end   := now() + interval '1 hour';
  end if;

  with ev as (   -- เฉพาะ event ของ "คนใช้จริง"
    select * from public.events
    where ts >= t_start and ts < t_end
      and coalesce(visitor_id,'') <> 'pipeline'
  ), px as (     -- เฉพาะ event ของ pipeline (GitHub Actions)
    select * from public.events
    where ts >= t_start and ts < t_end
      and visitor_id = 'pipeline'
  )
  select json_build_object(
    'is_day_mode', target_date is not null,
    'target_date', target_date,
    'range_days',  days,

    'totals', (select json_build_object(
        'opens',           count(*)                  filter (where type = 'open'),
        'unique_visitors', count(distinct visitor_id) filter (where type = 'open'),
        'approx_devices',  count(distinct md5(coalesce(ua,'') || '|' || coalesce(lang,'') || '|' || coalesce(tz,'')))
                                                     filter (where type = 'open'),
        'downloads',       count(*)                  filter (where type = 'download'),
        'copies',          count(*)                  filter (where type = 'copy')
      ) from ev),

    'returning_visitors', (select count(distinct visitor_id) from ev where type = 'open' and is_returning),
    'avg_events_per_visitor', (select coalesce(round(count(*)::numeric / nullif(count(distinct visitor_id),0), 1), 0) from ev),

    'by_day', (select coalesce(json_agg(row_to_json(j) order by j.day), '[]'::json) from (
        select to_char(ts at time zone '+07','YYYY-MM-DD') as day, count(*) as n
        from ev where type = 'open' group by 1) j),

    'by_day_actions', (select coalesce(json_agg(row_to_json(j) order by j.day), '[]'::json) from (
        select to_char(ts at time zone '+07','YYYY-MM-DD') as day,
               count(*) filter (where type = 'open')     as opens,
               count(*) filter (where type = 'download') as downloads,
               count(*) filter (where type = 'copy')     as copies
        from ev group by 1) j),

    'by_hour', (select coalesce(json_agg(row_to_json(j) order by j.hour), '[]'::json) from (
        select extract(hour from ts at time zone '+07')::int as hour, count(*) as n
        from ev group by 1) j),

    'by_type', (select coalesce(json_agg(row_to_json(j) order by j.n desc), '[]'::json) from (
        select type, count(*) as n from ev group by 1) j),

    'by_tz', (select coalesce(json_agg(row_to_json(j) order by j.n desc), '[]'::json) from (
        select tz, count(*) as n from ev where type = 'open' group by 1) j),

    'pipeline', (select json_build_object(
        'keeps',   (select count(*) from px where type = 'px_keep'),
        'rejects', (select count(*) from px where type = 'px_reject'),
        'avg_score', (select round(avg((ref::jsonb->>'score')::numeric), 1)
                      from px where type = 'px_keep' and ref like '{%'),
        'by_day', (select coalesce(json_agg(row_to_json(j) order by j.day), '[]'::json) from (
            select to_char(ts at time zone '+07','YYYY-MM-DD') as day,
                   count(*) filter (where type = 'px_keep')   as keeps,
                   count(*) filter (where type = 'px_reject') as rejects
            from px group by 1) j),
        'by_cat', (select coalesce(json_agg(row_to_json(j) order by j.n desc), '[]'::json) from (
            select coalesce(ref::jsonb->>'cat','?') as cat, count(*) as n
            from px where type = 'px_keep' and ref like '{%' group by 1) j),
        'runs', (select coalesce(json_agg(row_to_json(j)), '[]'::json) from (
            select to_char(ts at time zone '+07','MM-DD HH24:MI') as t, ref
            from px where type = 'px_run' order by ts desc limit 12) j)
      ))
  ) into result;

  return result;
end;
$$;

revoke all on function public.dashboard_stats2(text, int, text) from public;
grant execute on function public.dashboard_stats2(text, int, text) to anon;
