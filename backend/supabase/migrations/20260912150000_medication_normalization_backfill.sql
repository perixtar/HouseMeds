-- Audited, resumable normalization backfill. This migration only adds the
-- workflow structures; it does not normalize or repoint any production row.
create role housemed_backfill nologin;
grant usage on schema pricing to housemed_backfill;

create table pricing.medication_backfill_runs (
 id bigint generated always as identity primary key,
 status text not null default 'staged' check(status in ('staged','approved','applying','applied','failed','compensated')),
 normalization_version text not null,
 terminology_version text,
 snapshot_hash text not null check(snapshot_hash ~ '^[0-9a-f]{64}$'),
 backup_sha256 text not null check(backup_sha256 ~ '^[0-9a-f]{64}$'),
 backup_database_state_hash text not null check(backup_database_state_hash ~ '^[0-9a-f]{64}$'),
 backup_created_at timestamptz not null,
 backup_restore_verified boolean not null check(backup_restore_verified),
 baseline jsonb not null check(jsonb_typeof(baseline)='object'),
 summary jsonb not null check(jsonb_typeof(summary)='object'),
 reconciliation jsonb check(reconciliation is null or jsonb_typeof(reconciliation)='object'),
 created_at timestamptz not null default now(),
 approved_at timestamptz,
 approved_by text,
 applied_at timestamptz,
 compensated_at timestamptz,
 failure_code text,
 check((approved_at is null)=(approved_by is null)),
 check(status not in ('approved','applying','applied','compensated') or approved_at is not null),
 check(status not in ('applied','compensated') or applied_at is not null),
 check(status<>'compensated' or compensated_at is not null)
);
create unique index one_active_medication_backfill
 on pricing.medication_backfill_runs((true)) where status in ('staged','approved','applying');

create table pricing.medication_backfill_items (
 id bigint generated always as identity primary key,
 run_id bigint not null references pricing.medication_backfill_runs(id),
 legacy_medication_id bigint not null references pricing.medications(id),
 raw_snapshot jsonb not null check(jsonb_typeof(raw_snapshot)='object'),
 input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 decision_evidence jsonb not null check(jsonb_typeof(decision_evidence)='array'),
 normalized_identity jsonb check(normalized_identity is null or jsonb_typeof(normalized_identity)='object'),
 candidate_rxcuis jsonb not null default '[]' check(jsonb_typeof(candidate_rxcuis)='array'),
 decision_status text not null check(decision_status in ('ready','needs_review','unmatched')),
 reason text,
 proposed_normalized_key text,
 proposed_survivor_id bigint references pricing.medications(id),
 proposed_listing_units jsonb not null default '{}' check(jsonb_typeof(proposed_listing_units)='object'),
 collision_group_size integer not null default 1 check(collision_group_size>0),
 approval_status text not null check(approval_status in ('pending','collision_review','approved','requires_review','unmatched','applied','compensated')),
 approved_at timestamptz,
 approved_by text,
 applied_at timestamptz,
 compensated_at timestamptz,
 created_at timestamptz not null default now(),
 unique(run_id,legacy_medication_id),
 check((decision_status='ready')=(normalized_identity is not null)),
 check((decision_status='ready')=(proposed_normalized_key is not null)),
 check((decision_status='ready')=(proposed_survivor_id is not null)),
 check(approval_status not in ('approved','applied','compensated') or approved_at is not null),
 check(approval_status not in ('applied','compensated') or applied_at is not null),
 check(approval_status<>'compensated' or compensated_at is not null)
);
create index medication_backfill_items_review on pricing.medication_backfill_items(run_id,approval_status,id);

create table pricing.medication_backfill_events (
 id bigint generated always as identity primary key,
 run_id bigint not null references pricing.medication_backfill_runs(id),
 event_type text not null check(event_type in ('staged','approved','applying','applied','failed','compensated')),
 actor text not null,
 payload jsonb not null default '{}' check(jsonb_typeof(payload)='object'),
 created_at timestamptz not null default now()
);
create index medication_backfill_events_run on pricing.medication_backfill_events(run_id,id);

alter table pricing.medication_components
 add column backfill_run_id bigint references pricing.medication_backfill_runs(id);
alter table pricing.medication_matches
 add column backfill_run_id bigint references pricing.medication_backfill_runs(id);
drop index pricing.medication_matches_decision;
create unique index medication_matches_decision
 on pricing.medication_matches(listing_id,input_hash,normalization_version,coalesce(terminology_version,''),coalesce(backfill_run_id,0));
create index medication_components_backfill_run on pricing.medication_components(backfill_run_id) where backfill_run_id is not null;
create index medication_matches_backfill_run on pricing.medication_matches(backfill_run_id) where backfill_run_id is not null;

alter table pricing.medications add check(
 coalesce(normalization_status='superseded',false)=(superseded_by_id is not null)
);
alter table pricing.medications alter constraint medications_superseded_by_id_fkey deferrable initially deferred;

create function pricing.guard_backfill_item() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'Backfill plans are immutable'; end if;
 if new.run_id<>old.run_id or new.legacy_medication_id<>old.legacy_medication_id
   or new.raw_snapshot<>old.raw_snapshot or new.input_hash<>old.input_hash
   or new.decision_evidence<>old.decision_evidence
   or new.normalized_identity is distinct from old.normalized_identity
   or new.candidate_rxcuis<>old.candidate_rxcuis
   or new.decision_status<>old.decision_status or new.reason is distinct from old.reason
   or new.proposed_normalized_key is distinct from old.proposed_normalized_key
   or new.proposed_survivor_id is distinct from old.proposed_survivor_id
   or new.proposed_listing_units<>old.proposed_listing_units
   or new.collision_group_size<>old.collision_group_size
 then raise exception 'Backfill decision fields are immutable; create a new run'; end if;
 return new;
end $$;
create trigger guard_backfill_item before update or delete on pricing.medication_backfill_items for each row execute function pricing.guard_backfill_item();

create function pricing.guard_backfill_event() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'Backfill events are append-only'; end if;
 return new;
end $$;
create trigger guard_backfill_event before update or delete on pricing.medication_backfill_events for each row execute function pricing.guard_backfill_event();

create function pricing.guard_superseded_medication() returns trigger language plpgsql set search_path='' as $$
begin
 if new.superseded_by_id is not null and not exists(
  select 1 from pricing.medications target where target.id=new.superseded_by_id
   and target.normalization_status='verified' and target.superseded_by_id is null
 ) then raise exception 'Superseding medication must resolve directly to an active verified medication'; end if;
 return new;
end $$;
create constraint trigger guard_superseded_medication after insert or update on pricing.medications deferrable initially deferred for each row execute function pricing.guard_superseded_medication();

alter table pricing.medication_backfill_runs enable row level security;
alter table pricing.medication_backfill_items enable row level security;
alter table pricing.medication_backfill_events enable row level security;
revoke all on pricing.medication_backfill_runs,pricing.medication_backfill_items,pricing.medication_backfill_events from public,anon,authenticated;
revoke all on sequence pricing.medication_backfill_runs_id_seq,pricing.medication_backfill_items_id_seq,pricing.medication_backfill_events_id_seq from public,anon,authenticated;
revoke all on function pricing.guard_backfill_item(),pricing.guard_backfill_event(),pricing.guard_superseded_medication() from public,anon,authenticated;

grant select on pricing.medication_backfill_runs,pricing.medication_backfill_items,pricing.medication_backfill_events to housemed_worker;
grant select on pricing.medication_backfill_runs to housemed_reader;
grant select,insert,update on pricing.medication_backfill_runs,pricing.medication_backfill_items to housemed_backfill;
grant select,insert on pricing.medication_backfill_events to housemed_backfill;
grant select,insert,update on pricing.medications,pricing.listings to housemed_backfill;
grant select,insert,update,delete on pricing.medication_components to housemed_backfill;
grant select,insert on pricing.medication_matches to housemed_backfill;
grant select on pricing.sources,pricing.crawl_runs,pricing.crawl_pages,pricing.offers,pricing.offer_history to housemed_backfill;
grant usage,select on all sequences in schema pricing to housemed_backfill;

create policy worker_read_backfill_runs on pricing.medication_backfill_runs for select to housemed_worker using(true);
create policy worker_read_backfill_items on pricing.medication_backfill_items for select to housemed_worker using(true);
create policy worker_read_backfill_events on pricing.medication_backfill_events for select to housemed_worker using(true);
create policy reader_read_backfill_runs on pricing.medication_backfill_runs for select to housemed_reader using(true);
create policy backfill_access_runs on pricing.medication_backfill_runs for all to housemed_backfill using(true) with check(true);
create policy backfill_access_items on pricing.medication_backfill_items for all to housemed_backfill using(true) with check(true);
create policy backfill_read_events on pricing.medication_backfill_events for select to housemed_backfill using(true);
create policy backfill_insert_events on pricing.medication_backfill_events for insert to housemed_backfill with check(true);

create policy backfill_medications on pricing.medications for all to housemed_backfill using(true) with check(true);
create policy backfill_components on pricing.medication_components for all to housemed_backfill using(true) with check(true);
create policy backfill_listings on pricing.listings for all to housemed_backfill using(true) with check(true);
create policy backfill_matches_read on pricing.medication_matches for select to housemed_backfill using(true);
create policy backfill_matches_insert on pricing.medication_matches for insert to housemed_backfill with check(true);
create policy backfill_sources_read on pricing.sources for select to housemed_backfill using(true);
create policy backfill_runs_read on pricing.crawl_runs for select to housemed_backfill using(true);
create policy backfill_pages_read on pricing.crawl_pages for select to housemed_backfill using(true);
create policy backfill_offers_read on pricing.offers for select to housemed_backfill using(true);
create policy backfill_history_read on pricing.offer_history for select to housemed_backfill using(true);
