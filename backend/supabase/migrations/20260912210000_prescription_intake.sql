-- Private, tenant-scoped intake tables. No access through the public Data API.
begin;
create schema if not exists housemed;
revoke all on schema housemed from public, anon, authenticated;

create table housemed.households (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(name) between 1 and 160),
 created_at timestamptz not null default now()
);
create table housemed.members (
 id uuid primary key default gen_random_uuid(),
 household_id uuid not null references housemed.households(id),
 nickname text not null check(length(nickname) between 1 and 80),
 unique(household_id, id), unique(household_id, nickname)
);
create table housemed.drafts (
 id uuid primary key default gen_random_uuid(),
 household_id uuid not null references housemed.households(id),
 request_id uuid not null,
 fields jsonb not null check(jsonb_typeof(fields)='object'),
 normalization jsonb not null check(jsonb_typeof(normalization)='object'),
 created_at timestamptz not null default now(),
 unique(household_id, request_id), unique(household_id, id)
);
create table housemed.prescriptions (
 id uuid primary key default gen_random_uuid(),
 household_id uuid not null references housemed.households(id),
 member_id uuid not null,
 draft_id uuid not null,
 fields jsonb not null,
 normalization jsonb not null,
 confirmed_at timestamptz not null default now(),
 foreign key(household_id, member_id) references housemed.members(household_id, id),
 foreign key(household_id, draft_id) references housemed.drafts(household_id, id),
 unique(household_id, draft_id)
);
create index prescriptions_household_created on housemed.prescriptions(household_id, confirmed_at desc);

-- Runtime login is created separately with a generated password in Secrets Manager.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='housemed_mcp') then
  create role housemed_mcp login nosuperuser nocreatedb nocreaterole noinherit;
 end if;
end $$;
grant usage on schema housemed to housemed_mcp;
grant select on housemed.households, housemed.members to housemed_mcp;
grant select, insert on housemed.drafts, housemed.prescriptions to housemed_mcp;
-- SELECT FOR UPDATE serializes retries; UPDATE is needed for that lock, not data edits.
grant update on housemed.drafts to housemed_mcp;
alter table housemed.households enable row level security;
alter table housemed.members enable row level security;
alter table housemed.drafts enable row level security;
alter table housemed.prescriptions enable row level security;
create policy household_scope on housemed.households to housemed_mcp
 using(id=nullif(current_setting('app.household_id',true),'')::uuid);
create policy member_scope on housemed.members to housemed_mcp
 using(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
create policy draft_scope on housemed.drafts to housemed_mcp
 using(household_id=nullif(current_setting('app.household_id',true),'')::uuid)
 with check(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
create policy prescription_scope on housemed.prescriptions to housemed_mcp
 using(household_id=nullif(current_setting('app.household_id',true),'')::uuid)
 with check(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
commit;
