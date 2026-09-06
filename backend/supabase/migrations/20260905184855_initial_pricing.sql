-- Shared pricing catalog. Operational credentials are provisioned separately.
create schema pricing;
revoke all on schema pricing from public, anon, authenticated;

create table pricing.sources (
 id bigint generated always as identity primary key,
 slug text not null unique, name text not null, base_url text not null,
 enabled boolean not null default true
);
create table pricing.medications (
 id bigint generated always as identity primary key,
 name text not null, strength text not null, form text not null,
 route text not null, release_type text not null,
 unique(name,strength,form,route,release_type)
);
create table pricing.crawl_runs (
 id bigint generated always as identity primary key,
 source_id bigint not null references pricing.sources(id),
 started_at timestamptz not null default now(), finished_at timestamptz,
 status text not null default 'running' check(status in ('running','succeeded','partial','failed','interrupted')),
 checkpoint jsonb not null default '{}' check(jsonb_typeof(checkpoint)='object'),
 summary jsonb not null default '{}' check(jsonb_typeof(summary)='object'),
 parser_version text not null, evidence_path text,
 check(finished_at is null or finished_at>=started_at)
);
create index crawl_runs_source_time on pricing.crawl_runs(source_id,started_at desc);
create unique index one_active_source_run on pricing.crawl_runs(source_id) where status='running';
create table pricing.listings (
 id bigint generated always as identity primary key,
 source_id bigint not null references pricing.sources(id), source_product_key text not null,
 medication_id bigint references pricing.medications(id), source_name text not null, url text not null,
 brand_name text, sold_as text not null,
 content_quantity numeric check(content_quantity>0), content_unit text,
 match_status text not null default 'unmatched' check(match_status in ('unmatched','verified','needs_review')),
 metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object'),
 unique(source_id,source_product_key), unique(id,source_id),
 check(match_status<>'verified' or (medication_id is not null and content_quantity is not null and content_unit is not null))
);
create index listings_medication on pricing.listings(medication_id);
create table pricing.crawl_pages (
 id bigint generated always as identity primary key,
 source_id bigint not null references pricing.sources(id), url text not null,
 page_type text not null default 'unknown' check(page_type in ('unknown','directory','product','content','policy','ignored')),
 discovered_from text, listing_id bigint,
 first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 last_attempt_at timestamptz, last_success_at timestamptz, next_crawl_at timestamptz default now(),
 last_result text check(last_result in ('success','failed','blocked','not_found')),
 unique(source_id,url), foreign key(listing_id,source_id) references pricing.listings(id,source_id),
 check(last_success_at is null or last_attempt_at>=last_success_at)
);
create index crawl_pages_due on pricing.crawl_pages(source_id,next_crawl_at) where next_crawl_at is not null;
create index crawl_pages_listing on pricing.crawl_pages(listing_id,source_id);
create table pricing.offers (
 id bigint generated always as identity primary key,
 listing_id bigint not null references pricing.listings(id), offer_key text not null,
 quantity numeric not null check(quantity>0), seller_key text not null, location_key text not null,
 program_key text not null, price_cents bigint check(price_cents>=0),
 currency text not null default 'USD' check(currency='USD'),
 availability text not null check(availability in ('in_stock','out_of_stock','unknown')),
 terms jsonb not null default '{}' check(jsonb_typeof(terms)='object'), active boolean not null default true,
 last_checked_at timestamptz not null, valid_until timestamptz,
 crawl_run_id bigint not null references pricing.crawl_runs(id), unique(listing_id,offer_key),
 check(availability<>'in_stock' or price_cents is not null)
);
create index offers_run on pricing.offers(crawl_run_id);
create table pricing.offer_history (
 id bigint generated always as identity primary key,
 offer_id bigint not null references pricing.offers(id),
 crawl_run_id bigint not null references pricing.crawl_runs(id), observed_at timestamptz not null,
 price_cents bigint check(price_cents>=0), currency text not null check(currency='USD'),
 availability text not null check(availability in ('in_stock','out_of_stock','unknown')),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'), unique(offer_id,crawl_run_id)
);
create index offer_history_timeline on pricing.offer_history(offer_id,observed_at desc);
create index offer_history_run on pricing.offer_history(crawl_run_id);

create function pricing.guard_offer() returns trigger language plpgsql set search_path='' as $$
begin
 if (select source_id from pricing.listings where id=new.listing_id) is distinct from
    (select source_id from pricing.crawl_runs where id=new.crawl_run_id) then
   raise exception 'Offer and observation run must have the same source';
 end if;
 if tg_op='UPDATE' then
  if new.listing_id<>old.listing_id or new.offer_key<>old.offer_key or new.quantity<>old.quantity
    or new.seller_key<>old.seller_key or new.location_key<>old.location_key
    or new.program_key<>old.program_key or new.currency<>old.currency then
   raise exception 'Offer identity is immutable; create a distinct offer';
  end if;
  if new.last_checked_at<old.last_checked_at then raise exception 'Older observation rejected'; end if;
 end if;
 return new;
end $$;
create trigger guard_offer before insert or update on pricing.offers for each row execute function pricing.guard_offer();
create function pricing.guard_history() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'Price history is append-only'; end if;
 if not exists(select 1 from pricing.offers o join pricing.listings l on l.id=o.listing_id
   join pricing.crawl_runs r on r.id=new.crawl_run_id where o.id=new.offer_id and l.source_id=r.source_id)
 then raise exception 'History and run source mismatch'; end if;
 return new;
end $$;
create trigger guard_history before insert or update or delete on pricing.offer_history for each row execute function pricing.guard_history();

-- No anonymous or ordinary authenticated access to collection data.
revoke all on all tables in schema pricing from public, anon, authenticated;
revoke all on all sequences in schema pricing from public, anon, authenticated;
revoke all on all functions in schema pricing from public, anon, authenticated;
alter default privileges in schema pricing revoke all on tables from public, anon, authenticated;
alter default privileges in schema pricing revoke all on sequences from public, anon, authenticated;
alter default privileges in schema pricing revoke all on functions from public, anon, authenticated;
do $$ declare t text; begin
 foreach t in array array['sources','medications','crawl_runs','listings','crawl_pages','offers','offer_history'] loop
 execute format('alter table pricing.%I enable row level security',t);
 end loop;
end $$;
insert into pricing.sources(slug,name,base_url) values
 ('healthwarehouse','HealthWarehouse','https://www.healthwarehouse.com'),
 ('costplus','Cost Plus Drugs','https://www.costplusdrugs.com');
