-- ตั้งเวลาส่งคำอวยพรตอนเช้า: เรียก Edge Function line-morning ทุกวัน 23:00 UTC = 06:00 น. (เวลาไทย)
-- ใช้ pg_cron + pg_net (เปิด extension ก่อน) — รันใน SQL Editor ของโปรเจกต์
--
-- แทนค่า:
--   <PROJECT_REF> = project ref ของ Supabase (เช่น iuyiwpoupnuxnohpatyw)
--   <CRON_KEY>    = ค่าเดียวกับ ENV CRON_KEY ของ Edge Function line-morning (กันเรียกมั่ว)

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'line-morning-0600th',
  '0 23 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/line-morning',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key','<CRON_KEY>')
  );
  $$
);

-- ดูงานที่ตั้งไว้:    select * from cron.job;
-- ดูประวัติการรัน:    select * from cron.job_run_details order by start_time desc limit 10;
-- ยกเลิก:            select cron.unschedule('line-morning-0600th');
