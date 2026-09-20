CREATE TABLE public.slow_desk_events (
 event_id uuid PRIMARY KEY,
 event text NOT NULL CHECK(event IN ('page_view','play_start','listen_30s')),
 occurred_at bigint NOT NULL, received_at bigint NOT NULL,
 visitor_id uuid NOT NULL, session_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('direct','share','wechat','friend')),
 track_id text NOT NULL, track_title text NOT NULL, series_id text NOT NULL,
 test_data boolean NOT NULL
);
CREATE INDEX slow_desk_events_received ON public.slow_desk_events(received_at);
CREATE INDEX slow_desk_events_test_time ON public.slow_desk_events(test_data,occurred_at);
CREATE TABLE public.slow_desk_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 daily_cap integer NOT NULL DEFAULT 0 CHECK(daily_cap BETWEEN 0 AND 1000),
 test_data boolean NOT NULL DEFAULT true,
 admin_key_hash text CHECK(admin_key_hash ~ '^[a-f0-9]{64}$'),
 last_cleanup date
);
INSERT INTO public.slow_desk_settings(singleton) VALUES(true);
ALTER TABLE public.slow_desk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slow_desk_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.slow_desk_events,public.slow_desk_settings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.slow_desk_events TO service_role;
GRANT SELECT,UPDATE ON public.slow_desk_settings TO service_role;

CREATE FUNCTION public.slow_desk_admin_config() RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('admin_key_hash',admin_key_hash) FROM public.slow_desk_settings WHERE singleton;
$$;

CREATE FUNCTION public.slow_desk_ingest(payload jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
 cfg public.slow_desk_settings%ROWTYPE;
 now_ms bigint := floor(extract(epoch from clock_timestamp())*1000);
 start_ms bigint := floor(extract(epoch from (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))*1000);
 today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
 SELECT * INTO cfg FROM public.slow_desk_settings WHERE singleton FOR UPDATE;
 IF cfg.daily_cap IS NULL OR cfg.daily_cap<1 THEN RETURN 503; END IF;
 IF cfg.last_cleanup IS DISTINCT FROM today THEN
  DELETE FROM public.slow_desk_events WHERE received_at < now_ms-62::bigint*86400000;
  UPDATE public.slow_desk_settings SET last_cleanup=today WHERE singleton;
 END IF;
 IF EXISTS(SELECT 1 FROM public.slow_desk_events WHERE event_id=(payload->>'event_id')::uuid) THEN RETURN 409; END IF;
 IF (SELECT count(*) FROM public.slow_desk_events WHERE received_at>=start_ms)>=cfg.daily_cap
 OR (SELECT count(*) FROM public.slow_desk_events WHERE received_at>now_ms-1000)>=5
 OR (SELECT count(*) FROM public.slow_desk_events WHERE received_at>now_ms-60000)>=30 THEN RETURN 429; END IF;
 INSERT INTO public.slow_desk_events VALUES(
 (payload->>'event_id')::uuid,payload->>'event',floor(extract(epoch from (payload->>'occurred_at')::timestamptz)*1000),now_ms,
 (payload->>'visitor_id')::uuid,(payload->>'session_id')::uuid,payload->>'source',payload->>'track_id',payload->>'track_title',payload->>'series_id',cfg.test_data);
 RETURN 201;
END;
$$;

CREATE FUNCTION public.slow_desk_stats(p_days integer DEFAULT 7,p_test boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
 start_ms bigint; end_ms bigint:=floor(extract(epoch from clock_timestamp())*1000);
 summary jsonb; daily jsonb; tracks jsonb; sources jsonb; recent jsonb;
BEGIN
 IF p_days NOT IN(7,30) THEN RAISE EXCEPTION 'Invalid date range'; END IF;
 start_ms:=floor(extract(epoch from ((date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')-(p_days-1)*interval '1 day') AT TIME ZONE 'Asia/Shanghai'))*1000);
 SELECT jsonb_build_object('opens',count(*) FILTER(WHERE event='page_view'),
 'visitors',count(DISTINCT visitor_id) FILTER(WHERE event='page_view'),
 'plays',count(*) FILTER(WHERE event='play_start'),'listens',count(*) FILTER(WHERE event='listen_30s')) INTO summary
 FROM public.slow_desk_events WHERE test_data=p_test AND occurred_at BETWEEN start_ms AND end_ms;
 SELECT coalesce(jsonb_agg(x ORDER BY x.day),'[]'::jsonb) INTO daily FROM(
 SELECT to_char(to_timestamp(occurred_at/1000.0) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
 count(*) FILTER(WHERE event='page_view') AS opens,count(DISTINCT visitor_id) FILTER(WHERE event='page_view') AS visitors,
 count(*) FILTER(WHERE event='play_start') AS plays,count(*) FILTER(WHERE event='listen_30s') AS listens
 FROM public.slow_desk_events WHERE test_data=p_test AND occurred_at BETWEEN start_ms AND end_ms GROUP BY day) x;
 SELECT coalesce(jsonb_agg(x ORDER BY x.plays DESC,x.listens DESC),'[]'::jsonb) INTO tracks FROM(
 SELECT track_id,track_title,count(*) FILTER(WHERE event='play_start') AS plays,count(*) FILTER(WHERE event='listen_30s') AS listens
 FROM public.slow_desk_events WHERE test_data=p_test AND occurred_at BETWEEN start_ms AND end_ms AND event<>'page_view'
 GROUP BY track_id,track_title ORDER BY plays DESC,listens DESC LIMIT 20) x;
 SELECT coalesce(jsonb_agg(x ORDER BY x.opens DESC),'[]'::jsonb) INTO sources FROM(
 SELECT source,count(*) AS opens FROM public.slow_desk_events WHERE test_data=p_test AND occurred_at BETWEEN start_ms AND end_ms AND event='page_view'
 GROUP BY source) x;
 SELECT coalesce(jsonb_agg(x ORDER BY x.occurred_at DESC),'[]'::jsonb) INTO recent FROM(
 SELECT event,occurred_at,visitor_id,source,track_title FROM public.slow_desk_events WHERE test_data=p_test AND occurred_at BETWEEN start_ms AND end_ms
 ORDER BY occurred_at DESC LIMIT 50) x;
 RETURN jsonb_build_object('days',p_days,'test',p_test,'generated_at',end_ms,'summary',summary,'daily',daily,'tracks',tracks,'sources',sources,'recent',recent);
END;
$$;
REVOKE ALL ON FUNCTION public.slow_desk_admin_config(),public.slow_desk_ingest(jsonb),public.slow_desk_stats(integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.slow_desk_admin_config(),public.slow_desk_ingest(jsonb),public.slow_desk_stats(integer,boolean) TO service_role;
