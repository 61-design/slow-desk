CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('slow-desk-retention','0 20 * * *', $job$
 DELETE FROM public.slow_desk_events WHERE received_at < floor(extract(epoch from now())*1000)-62::bigint*86400000;
 DELETE FROM cron.job_run_details WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='slow-desk-retention') AND end_time<now()-interval '7 days';
$job$);
