-- Add members through the existing tenant-scoped MCP service account.
begin;
grant insert (id, name) on housemed.households to housemed_mcp;
grant insert (id, household_id, nickname) on housemed.members to housemed_mcp;
alter policy member_scope on housemed.members to housemed_mcp
 using (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
 with check (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
commit;
