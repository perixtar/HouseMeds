import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';import pg from 'pg';
import {SourceClient} from '../../src/sources.ts';import {CP_API} from '../../src/core.ts';

// Only source/storage boundaries are controlled. The CLI, parsers, repository,
// SQL transactions, evidence filesystem, and API remain the production code.
const [manifestFile,scenarioFile]=process.argv.slice(2),scenario=JSON.parse(await readFile(scenarioFile,'utf8'));
const conn=new URL(process.env.DATABASE_URL);assert.equal(conn.pathname,'/housemed_e2e_test');assert.equal(conn.hostname,'localhost');assert.equal(conn.searchParams.get('host'),process.env.HOUSEMED_E2E_SOCKET);
assert.equal(process.env.SUPABASE_PROJECT_REF,'housemed-e2e-fixture');assert.ok(['','fixture-key-not-a-real-credential'].includes(process.env.SUPABASE_SECRET_KEY));
const counts={source_requests:0,storage_requests:0};
globalThis.fetch=async(url,options={})=>{
 const target=new URL(url);
 if(target.hostname==='housemed-e2e-fixture.supabase.co'&&target.pathname.startsWith('/storage/v1/object/housemed-evidence/')){
  counts.storage_requests++;assert.equal(options.method,'POST');assert.equal(new Headers(options.headers).get('x-upsert'),'false');
  return Response.json({error:'controlled storage outage'},{status:503});
 }
 if(scenario.source_status&&target.hostname==='www.healthwarehouse.com'){counts.source_requests++;return new Response('',{status:scenario.source_status,headers:scenario.source_status===429?{'Retry-After':'120'}:{}});}
 if(target.origin===new URL(CP_API).origin&&target.pathname===new URL(CP_API).pathname){
  counts.source_requests++;const q=target.searchParams.get('quantity_units');
  if(q&&scenario.missing_quantity===q)return Response.json({results:[]});
  const row=structuredClone(scenario.catalog);if(q){row.requested_quote_units=q;row.requested_quote=scenario.prices[q];}
  return Response.json({results:[row]});
 }
 throw Error('CONTROLLED_E2E_UNEXPECTED_NETWORK_REQUEST');
};
SourceClient.prototype.init=async()=>{};SourceClient.prototype.pace=async()=>{};
SourceClient.prototype.open=async function(url){
 if(scenario.source_status){await this.get(url);throw Error('EXPECTED_CONTROLLED_SOURCE_FAILURE');}
 assert.equal(scenario.source,'healthwarehouse');const snap=structuredClone(scenario.snapshot);snap.url=url;return snap;
};
if(scenario.clock_offset_ms){
 const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[RealDate.now()+scenario.clock_offset_ms]));}static now(){return RealDate.now()+scenario.clock_offset_ms;}};
}
if(scenario.write_fault){
 const original=pg.Client.prototype.query;
 pg.Client.prototype.query=function(...args){
  if(typeof args[0]==='string'&&args[0].startsWith('insert into pricing.offer_history')){
   if(scenario.write_fault==='kill_before_history'){process.send?.({event:'transaction_open_before_history'});return new Promise(()=>{});}
   if(scenario.write_fault==='sql_error')return original.call(this,'select 1/0');
  }
  return original.apply(this,args);
 };
}
process.on('exit',()=>console.log(JSON.stringify({event:'controlled_http_counts',...counts})));
process.argv=[process.execPath,resolve(new URL('../../src/cli.ts',import.meta.url).pathname),'collect',scenario.source,'--manifest',manifestFile,'--access-test','--fresh',...(scenario.resume_blocked?['--resume-blocked']:[])];
await import('../../src/cli.ts');
