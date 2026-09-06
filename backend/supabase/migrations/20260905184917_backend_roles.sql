create role housemed_worker nologin; create role housemed_reader nologin;
grant usage on schema pricing to housemed_worker,housemed_reader;
grant select,insert,update on all tables in schema pricing to housemed_worker;
revoke update on pricing.offer_history from housemed_worker;
grant usage,select on all sequences in schema pricing to housemed_worker;
grant select on pricing.sources,pricing.medications,pricing.listings,pricing.offers to housemed_reader;
grant select(id,source_id,started_at,finished_at,status,summary) on pricing.crawl_runs to housemed_reader;
do $$ declare t text; begin
foreach t in array array['sources','medications','listings','offers','crawl_runs','crawl_pages','offer_history'] loop
execute format('create policy worker_access on pricing.%I for all to housemed_worker using(true) with check(true)',t);
end loop;
foreach t in array array['sources','medications','listings','offers','crawl_runs'] loop
execute format('create policy reader_access on pricing.%I for select to housemed_reader using(true)',t);
end loop; end $$;
