-- Allow the existing household-scoped MCP runtime to read only the public
-- pricing tables needed by the deals endpoint. No pricing writes are granted.
grant usage on schema pricing to housemed_mcp;
grant select on pricing.sources, pricing.medications, pricing.listings, pricing.offers to housemed_mcp;

create policy mcp_read on pricing.sources for select to housemed_mcp using (true);
create policy mcp_read on pricing.medications for select to housemed_mcp using (true);
create policy mcp_read on pricing.listings for select to housemed_mcp using (true);
create policy mcp_read on pricing.offers for select to housemed_mcp using (true);
