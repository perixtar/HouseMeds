-- Additive schema for normalization of new medication identities.
-- Existing rows remain legacy/null until the separate backfill milestone.
alter table pricing.medications
 add column canonical_name text,
 add column normalized_name text,
 add column normalized_key text,
 add column rxnorm_rxcui text,
 add column rxnorm_term_type text check(rxnorm_term_type in ('SCD','SBD')),
 add column normalization_status text check(normalization_status in ('verified','needs_review','unmatched','superseded','retired')),
 add column normalization_version text,
 add column terminology_version text,
 add column superseded_by_id bigint references pricing.medications(id),
 add column brand_name text,
 add check(rxnorm_rxcui is null or rxnorm_rxcui ~ '^[0-9]+$'),
 add check(normalization_status<>'verified' or (canonical_name is not null and normalized_name is not null and normalized_key is not null and normalization_version is not null)),
 add check(superseded_by_id is null or superseded_by_id<>id);

-- The original exact-text constraint remains useful only for untouched legacy rows.
-- Normalized rows are keyed by normalized_key/RXCUI and may otherwise collide with it.
alter table pricing.medications drop constraint medications_name_strength_form_route_release_type_key;
create unique index medications_legacy_identity
 on pricing.medications(name,strength,form,route,release_type)
 where normalized_key is null and superseded_by_id is null;

create unique index medications_active_normalized_key
 on pricing.medications(normalized_key)
 where normalization_status='verified' and superseded_by_id is null;
create unique index medications_active_rxcui
 on pricing.medications(rxnorm_rxcui)
 where normalization_status='verified' and superseded_by_id is null and rxnorm_rxcui is not null;

create table pricing.medication_components (
 id bigint generated always as identity primary key,
 medication_id bigint not null references pricing.medications(id),
 sequence integer not null check(sequence>0),
 ingredient_name text not null,
 ingredient_rxcui text check(ingredient_rxcui is null or ingredient_rxcui ~ '^[0-9]+$'),
 precise_ingredient_rxcui text check(precise_ingredient_rxcui is null or precise_ingredient_rxcui ~ '^[0-9]+$'),
 numerator_value numeric not null check(numerator_value>0),
 numerator_unit text not null check(numerator_unit in ('mcg','mg','g','ml','l','units','iu','meq','percent')),
 denominator_value numeric check(denominator_value>0),
 denominator_unit text check(denominator_unit in ('mcg','mg','g','ml','l','units','iu','meq','percent','tablet','capsule','patch','inhaler','vial','syringe','pen','ampule','suppository','lozenge','dose')),
 unique(medication_id,sequence),
 check((denominator_value is null)=(denominator_unit is null))
);
create index medication_components_ingredient on pricing.medication_components(ingredient_rxcui);

create table pricing.medication_matches (
 id bigint generated always as identity primary key,
 source_id bigint not null references pricing.sources(id),
 listing_id bigint not null references pricing.listings(id),
 input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 raw_identity jsonb not null check(jsonb_typeof(raw_identity)='object'),
 normalized_identity jsonb check(normalized_identity is null or jsonb_typeof(normalized_identity)='object'),
 candidate_rxcuis jsonb not null default '[]' check(jsonb_typeof(candidate_rxcuis)='array'),
 selected_medication_id bigint references pricing.medications(id),
 match_method text not null check(match_method in ('ndc','rxnorm_exact','rxnorm_normalized','rxnorm_approximate','reviewed_input','none')),
 match_status text not null check(match_status in ('verified','needs_review','unmatched')),
 reason text,
 normalization_version text not null,
 terminology_version text,
 evidence_path text not null,
 created_at timestamptz not null default now(),
 check(match_status<>'verified' or selected_medication_id is not null)
);
create unique index medication_matches_decision
 on pricing.medication_matches(listing_id,input_hash,normalization_version,coalesce(terminology_version,''));
create index medication_matches_review on pricing.medication_matches(match_status,created_at) where match_status<>'verified';

create function pricing.guard_medication_match() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'Medication match evidence is append-only'; end if;
 return new;
end $$;
create trigger guard_medication_match before update or delete on pricing.medication_matches for each row execute function pricing.guard_medication_match();

alter table pricing.medication_components enable row level security;
alter table pricing.medication_matches enable row level security;
revoke all on pricing.medication_components,pricing.medication_matches from public,anon,authenticated;
revoke all on sequence pricing.medication_components_id_seq,pricing.medication_matches_id_seq from public,anon,authenticated;
revoke all on function pricing.guard_medication_match() from public,anon,authenticated;

grant select,insert,update on pricing.medication_components,pricing.medication_matches to housemed_worker;
revoke update on pricing.medication_matches from housemed_worker;
grant usage,select on sequence pricing.medication_components_id_seq,pricing.medication_matches_id_seq to housemed_worker;
grant select on pricing.medication_components to housemed_reader;

create policy worker_access on pricing.medication_components for all to housemed_worker using(true) with check(true);
create policy worker_insert_match on pricing.medication_matches for insert to housemed_worker with check(true);
create policy worker_read_match on pricing.medication_matches for select to housemed_worker using(true);
create policy reader_access on pricing.medication_components for select to housemed_reader using(true);
