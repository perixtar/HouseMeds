begin;
alter table housemed.drafts add column intake_id uuid;
alter table housemed.drafts add column intake_index integer not null default 0;
create index drafts_by_intake on housemed.drafts(household_id,intake_id,intake_index);
commit;
