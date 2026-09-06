import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawn,execFileSync,spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {makePool} from '../src/db.ts';
import {hash,stable} from '../src/core.ts';

const pool=makePool(),suiteId='live-'+new Date().toISOString().replaceAll(':','-');
const directory=resolve('data/audits/e2e',suiteId),reportPath='data/reports/e2e-live.json';
await mkdir(directory,{recursive:true});await mkdir('data/manifests',{recursive:true});
const report={suite_id:suiteId,scope:'preliminary_backend_live_e2e',started_at:new Date().toISOString(),code_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),artifact_directory:directory,status:'running',checks:[],stages:[],browser_verification:'pending',final_mvp_acceptance:false};
const save=async()=>{const body=JSON.stringify(report,null,2)+'\n',temporary=reportPath+'.'+randomUUID()+'.tmp';await writeFile(temporary,body,{mode:0o600});await rename(temporary,reportPath);};
const record=async(name,details)=>{report.checks.push({name,status:'passed',...details});await save();};
let manifest,paused=false,wasDisabled=false;
const domain='gui/'+process.getuid(),service=domain+'/com.housemed.discovery';
async function snapshot(name){
 const ids=manifest.listings.map(x=>x.listing_id);
 const listings=(await pool.query('select l.*,s.slug as source from pricing.listings l join pricing.sources s on s.id=l.source_id where l.id=any($1::bigint[]) order by l.id',[ids])).rows;
 const offers=(await pool.query('select * from pricing.offers where listing_id=any($1::bigint[]) order by id',[ids])).rows;
 const history=(await pool.query('select h.* from pricing.offer_history h join pricing.offers o on o.id=h.offer_id where o.listing_id=any($1::bigint[]) order by h.id',[ids])).rows;
 const data=JSON.parse(JSON.stringify({at:new Date().toISOString(),listings,offers,history}));
 await writeFile(directory+'/'+name+'.json',JSON.stringify(data,null,2)+'\n',{mode:0o600});return data;
}
async function collect(source,file,label){
 const logPath=directory+'/'+label+'-'+source+'.log';let output='';
 const code=await new Promise((done,reject)=>{
  const child=spawn(process.execPath,['--import','tsx',resolve('src/cli.ts'),'collect',source,'--manifest',file,'--access-test','--fresh','--minutes','10'],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>{output+=x;});child.stderr.on('data',x=>{output+=x;});child.once('error',reject);child.once('close',done);
 });
 await writeFile(logPath,output,{mode:0o600});
 const events=output.split('\n').flatMap(x=>{try{return [JSON.parse(x)];}catch{return [];}}),finished=events.findLast(x=>x.event==='run_finished');
 const stage={label,source,exit_code:code,run_id:finished?.run_id??events.findLast(x=>x.run_id)?.run_id,log_path:logPath,summary:finished??null};report.stages.push(stage);await save();
 assert.equal(code,0,'Collector failed; see '+logPath);assert.equal(finished?.status,'succeeded','Incomplete collector; see '+logPath);return stage;
}
async function both(file,label){const result=await Promise.allSettled(['healthwarehouse','costplus'].map(source=>collect(source,file,label)));for(const r of result)if(r.status==='rejected')throw r.reason;return result.map(r=>r.value);}
async function pauseDiscovery(){
 const settings=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',resolve(homedir(),'Library/LaunchAgents/com.housemed.discovery.plist')],{encoding:'utf8'}));assert.equal(settings.WorkingDirectory,process.cwd(),'Wrong discovery workspace');
 const disabled=execFileSync('/bin/launchctl',['print-disabled',domain],{encoding:'utf8'});wasDisabled=/"com\.housemed\.discovery"\s*=>\s*disabled/.test(disabled);
 execFileSync('/bin/launchctl',['disable',service]);paused=true;report.discovery_pause={started_at:new Date().toISOString(),previously_disabled:wasDisabled};await save();
 const current=spawnSync('/bin/launchctl',['print',service],{encoding:'utf8'}),pid=Number(current.stdout.match(/pid = (\d+)/)?.[1]);
 if(pid){process.kill(pid,'SIGTERM');const deadline=Date.now()+60000;while(Date.now()<deadline){try{process.kill(pid,0);}catch{return;}await delay(250);}throw Error('DISCOVERY_DID_NOT_EXIT_GRACEFULLY');}
}
async function resumeDiscovery(){
 if(!paused)return;if(!wasDisabled){execFileSync('/bin/launchctl',['enable',service]);execFileSync('/bin/launchctl',['kickstart',service]);}
 report.discovery_pause.resumed_at=new Date().toISOString();report.discovery_pause.configuration_restored=true;paused=false;await save();
}
try{
 const seed=JSON.parse(await readFile('data/manifests/access-test.json','utf8'));
 const rows=(await pool.query(`select p.id as page_id,p.url,l.id as listing_id,l.source_product_key,l.medication_id,l.match_status,s.slug as source,
 coalesce((select jsonb_agg(o.quantity::text order by o.quantity) from pricing.offers o where o.listing_id=l.id and o.active),'[]'::jsonb) as quantities
 from pricing.crawl_pages p join pricing.sources s on s.id=p.source_id join pricing.listings l on l.id=p.listing_id where p.url=any($1::text[])`,[seed.listings.map(x=>x.url)])).rows;
 assert.equal(rows.length,20,'Existing 10+10 source cohort must be present');
 manifest={purpose:'Frozen preliminary E2E sample; not the final acceptance cohort',suite_id:suiteId,inventory_audit_passed:false,listing_audit_passed:false,listings:seed.listings.map(seed=>{
  const row=rows.find(x=>x.source===seed.source&&x.url===seed.url);assert.ok(row);const planned=row.source==='costplus'?['30','90']:row.quantities;assert.ok(planned.length);
  return {source:row.source,page_id:row.page_id,listing_id:row.listing_id,url:row.url,source_product_key:row.source_product_key,planned_quantities:planned};
 })};
 const pair={...manifest,listings:manifest.listings.filter(x=>x.url.includes('/lisinopril-20mg-'))};assert.equal(pair.listings.length,2);
 assert.ok(rows.filter(x=>pair.listings.some(p=>p.listing_id===x.listing_id)).every(x=>x.match_status==='verified'&&x.medication_id==='1'));
 const fullPath=resolve('data/manifests/e2e-live.json'),pairPath=resolve('data/manifests/e2e-pair.json');await writeFile(fullPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});await writeFile(pairPath,JSON.stringify(pair,null,2)+'\n',{mode:0o600});
 report.manifest_path=fullPath;report.manifest_sha256=hash(stable(manifest));report.pair_manifest_path=pairPath;
 await snapshot('before');await pauseDiscovery();
 try{
  await both(pairPath,'pair-first');const first=await snapshot('pair-first');
  const repeats=await both(pairPath,'pair-repeat');const second=await snapshot('pair-repeat');
  let changed=0,unchanged=0,refreshed=0;
  for(const item of pair.listings){const stage=repeats.find(x=>x.source===item.source);const before=first.offers.filter(x=>x.listing_id===item.listing_id);
   for(const a of before){const b=second.offers.find(x=>x.id===a.id);assert.ok(b);if(item.planned_quantities.includes(a.quantity)){assert.ok(Date.parse(b.last_checked_at)>Date.parse(a.last_checked_at));refreshed++;}const differs=['price_cents','availability','active','valid_until'].some(k=>a[k]!==b[k])||stable(a.terms)!==stable(b.terms);
    const history=second.history.filter(x=>x.offer_id===a.id&&x.crawl_run_id===stage.run_id);assert.equal(history.length,differs?1:0,'History must match actual state change');if(differs)changed++;else unchanged++;
   }
  }
  await record('repeat_collection_history',{changed_offers:changed,unchanged_offers:unchanged,planned_timestamps_refreshed:refreshed});
  const expanded=await both(fullPath,'expanded');const after=await snapshot('after');
  let checked=0;for(const item of manifest.listings){const stage=expanded.find(x=>x.source===item.source);for(const quantity of item.planned_quantities){const offer=after.offers.find(x=>x.listing_id===item.listing_id&&x.quantity===quantity&&x.active);assert.ok(offer,'Planned quantity missing');assert.equal(offer.crawl_run_id,stage.run_id);assert.ok(offer.price_cents!==null);if(item.source==='costplus'){assert.equal(offer.availability,'unknown');assert.equal(offer.terms.quote_kind,'estimate');}checked++;}}
  await record('expanded_collection',{listings:20,planned_quantity_checks:checked,verified_listings:after.listings.filter(x=>x.match_status==='verified').length,unmatched_or_review:after.listings.filter(x=>x.match_status!=='verified').length});
 }finally{await resumeDiscovery();}
 const apiEnv=parseEnv(await readFile('.env.api','utf8')),http=[];
 async function get(path,authorized=true,method='GET'){
  const response=await fetch('http://127.0.0.1:63813'+path,{method,headers:authorized?{authorization:'Bearer '+apiEnv.HOUSEMED_API_TOKEN}:{},signal:AbortSignal.timeout(20000)});const body=await response.json();http.push({path,method,status:response.status,body});return {status:response.status,body};
 }
 assert.equal((await get('/v1/sources/status',false)).status,401);assert.equal((await get('/v1/medications',true,'POST')).status,404);
 const search=await get('/v1/medications?q=lisinopril');assert.equal(search.status,200);assert.ok(search.body.items.some(x=>x.id==='1'));
 const after=await snapshot('api-state');
 for(const quantity of ['30','90']){
  const strict=await get('/v1/medications/1/offers?quantity='+quantity+'&unit=tablet');assert.equal(strict.status,200);assert.ok(strict.body.items.every(x=>x.availability==='in_stock'));assert.ok(strict.body.items.some(x=>x.source==='healthwarehouse'));assert.ok(!strict.body.items.some(x=>x.source==='costplus'));
  const estimates=await get('/v1/medications/1/offers?quantity='+quantity+'&unit=tablet&include_estimates=true');assert.equal(estimates.status,200);assert.equal(estimates.body.items.length,2);assert.equal(estimates.body.quote_status,'includes_unconfirmed_estimates');
  for(const item of estimates.body.items){const stored=after.offers.find(x=>x.id===item.offer_id);assert.ok(stored);assert.equal(item.price_cents,stored.price_cents);assert.equal(item.ordering_quantity,stored.quantity);if(item.source==='costplus')assert.equal(item.purchase_verification_required,true);}
 }
 const unsupported=await get('/v1/medications/1/offers?quantity=31&unit=tablet&include_estimates=true');assert.equal(unsupported.body.items.length,0);assert.equal(unsupported.body.quote_status,'no_eligible_exact_quote');
 assert.equal((await get('/v1/medications/1/offers?quantity=0&unit=tablet')).status,400);
 const statuses=await get('/v1/sources/status');assert.equal(statuses.status,200);assert.equal(statuses.body.sources.length,2);
 const reader=makePool(true);try{const privileges=(await reader.query("select current_user::text as role,has_table_privilege(current_user,'pricing.offers','INSERT') as can_insert,has_table_privilege(current_user,'pricing.offers','UPDATE') as can_update,has_table_privilege(current_user,'pricing.offer_history','DELETE') as can_delete_history,has_table_privilege(current_user,'pricing.crawl_pages','SELECT') as can_read_crawl_pages")).rows[0];for(const key of ['can_insert','can_update','can_delete_history','can_read_crawl_pages'])assert.equal(privileges[key],false);await record('hosted_reader_role_boundaries',privileges);}finally{await reader.end();}
 assert.ok(!JSON.stringify(http).includes(apiEnv.HOUSEMED_API_TOKEN));assert.ok(!JSON.stringify(http).includes('evidence_path'));
 await writeFile(directory+'/http.json',JSON.stringify(http,null,2)+'\n',{mode:0o600});await record('live_http_contract',{requests:http.length,real_http:true});
 report.status='passed';report.finished_at=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,suite_id:suiteId,report:reportPath,artifact_directory:directory,stages:report.stages.map(x=>({label:x.label,source:x.source,run_id:x.run_id}))}));
}catch(error){report.status='failed';report.failure=error.message;report.finished_at=new Date().toISOString();await save();console.error(JSON.stringify({status:'failed',reason:error.message,report:reportPath}));process.exitCode=1;}
finally{try{await resumeDiscovery();}finally{await pool.end();}}
