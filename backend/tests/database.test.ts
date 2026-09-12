import {before,after,test} from 'node:test';import assert from 'node:assert/strict';
import pg from 'pg';import {readFile,readdir} from 'node:fs/promises';import {resolve} from 'node:path';
import {Repository} from '../src/repository.js';import {buildApi} from '../src/api.js';import type {Observation,Quote} from '../src/core.js';
import {MedicationNormalizer,type TerminologyResolver} from '../src/normalization.js';
const host=resolve('.cache/pgsock'),port=65431,dbName='housemed_test';
let admin:pg.Pool,worker:pg.Pool,reader:pg.Pool,repo:Repository,sourceId:string;let sequence=0;
const token='test-token-that-is-at-least-32-characters';
before(async()=>{
 const bootstrap=new pg.Pool({host,port,database:'postgres',max:1});
 const path=(await bootstrap.query('show data_directory')).rows[0].data_directory;
 assert.equal(resolve(path),resolve('.cache/pg-test'),'Refuse destructive tests outside the isolated local cluster');
 await bootstrap.query(`drop database if exists ${dbName} with(force)`);await bootstrap.query(`create database ${dbName}`);
 for(const role of ['housemed_worker','housemed_reader','anon','authenticated','service_role'])await bootstrap.query(`drop role if exists ${role}`);
 for(const role of ['anon','authenticated','service_role'])await bootstrap.query(`create role ${role}`);
 await bootstrap.end();admin=new pg.Pool({host,port,database:dbName,max:1});
 for(const f of (await readdir('supabase/migrations')).filter(x=>x.endsWith('.sql')).sort())await admin.query(await readFile('supabase/migrations/'+f,'utf8'));
 await admin.query('alter role housemed_worker login; alter role housemed_reader login');
 worker=new pg.Pool({host,port,database:dbName,user:'housemed_worker',max:2});reader=new pg.Pool({host,port,database:dbName,user:'housemed_reader',max:2});repo=new Repository(worker);sourceId=(await repo.source('healthwarehouse')).id;
});
after(async()=>{await Promise.all([admin?.end(),worker?.end(),reader?.end()]);});
async function withRun<T>(fn:(id:string)=>Promise<T>):Promise<T>{const id=(await worker.query("insert into pricing.crawl_runs(source_id,parser_version) values($1,'test') returning id",[sourceId])).rows[0].id;try{return await fn(id);}finally{await worker.query("update pricing.crawl_runs set status='succeeded',finished_at=now() where id=$1",[id]);}}
async function withSourceRun<T>(selectedSourceId:string,fn:(id:string)=>Promise<T>):Promise<T>{const id=(await worker.query("insert into pricing.crawl_runs(source_id,parser_version) values($1,'normalization-e2e') returning id",[selectedSourceId])).rows[0].id;try{return await fn(id);}finally{await worker.query("update pricing.crawl_runs set status='succeeded',finished_at=now() where id=$1",[id]);}}
function observation(key='product-'+(++sequence)):Observation{return {listing:{source_product_key:key,source_name:'Lisinopril Test 20mg Tablets',url:'https://www.healthwarehouse.com/'+key,brand_name:null,sold_as:'tablet',content_quantity:'1',content_unit:'tablet',medication:{name:'lisinopril-test-'+key,strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate'},metadata:{}},offers:[{quantity:'30',price_cents:'900',currency:'USD',availability:'in_stock',seller_key:'healthwarehouse',location_key:'online-us',program_key:'cash',terms:{quote_kind:'source_product_total',shipping:null},valid_until:null,active:true}],observed_at:new Date().toISOString(),evidence_path:'local://test.json',complete:true};}
const count=async(listing:string)=>(await admin.query('select count(*)::int as n from pricing.offer_history h join pricing.offers o on o.id=h.offer_id where o.listing_id=$1',[listing])).rows[0].n;
async function apiGet(path:string){const app=buildApi(reader,token);try{return await app.inject({url:path,headers:{authorization:'Bearer '+token}});}finally{await app.close();}}
test('nine tables and private access boundaries',async()=>{assert.equal((await admin.query("select count(*)::int as n from information_schema.tables where table_schema='pricing' and table_type='BASE TABLE'")).rows[0].n,9);await assert.rejects(reader.query("update pricing.sources set name='bad'"),{code:'42501'});await assert.rejects(reader.query('select evidence_path from pricing.crawl_runs'),{code:'42501'});await assert.rejects(reader.query('select * from pricing.medication_matches'),{code:'42501'});await assert.rejects(worker.query('update pricing.medication_matches set reason=null'),{code:'42501'});await admin.query('set role anon');try{await assert.rejects(admin.query('select * from pricing.offers'),{code:'42501'});}finally{await admin.query('reset role');}});

test('incoming normalized identities can coexist with untouched exact-text legacy rows until backfill',async()=>{
 await worker.query("insert into pricing.medications(name,strength,form,route,release_type) values('coexist-medication','20 mg','tablet','oral','immediate')");
 const normalizedRepo=new Repository(worker,new MedicationNormalizer({resolve:async()=>({method:'rxnorm_exact',version:'fixture',concepts:[{rxcui:'999000001',name:'coexist-medication 20 MG Oral Tablet',tty:'SCD'}]})}));
 const o=observation('coexist-normalized');delete o.listing.medication;o.listing.identity_candidate={name:'coexist-medication',strength:'20MG',form:'tablets',route:'oral',release_type:'immediate'};o.listing.source_name='Coexist Medication 20MG Tablets';
 await withRun(id=>normalizedRepo.saveObservation(sourceId,id,o));
 const rows=(await worker.query("select normalization_status,normalized_key from pricing.medications where name='coexist medication' or name='coexist-medication' order by id")).rows;assert.equal(rows.length,2);assert.equal(rows[0].normalization_status,null);assert.equal(rows[1].normalization_status,'verified');assert.equal(rows[1].normalized_key,'rxnorm:999000001');
});

test('incoming normalization does not relink or annotate an existing legacy listing before backfill',async()=>{
 const medication=(await worker.query("insert into pricing.medications(name,strength,form,route,release_type) values('legacy-incoming','20 mg','tablet','oral','immediate') returning id")).rows[0];
 const key='legacy-existing-'+(++sequence);
 const listing=(await worker.query("insert into pricing.listings(source_id,source_product_key,medication_id,source_name,url,brand_name,sold_as,content_quantity,content_unit,match_status,metadata) values($1,$2,$3,'Legacy Incoming 20mg Tablets',$4,null,'tablet','1','tablet','verified',$5) returning id",[sourceId,key,medication.id,'https://www.healthwarehouse.com/'+key,JSON.stringify({legacy_marker:'keep'})])).rows[0];
 let resolverCalls=0;const normalizedRepo=new Repository(worker,new MedicationNormalizer({resolve:async()=>{resolverCalls++;return {method:'rxnorm_normalized',version:'fixture',concepts:[{rxcui:'999000002',name:'legacy-incoming 20 MG Oral Tablet',tty:'SCD'}]};}}));
 const o=observation(key);delete o.listing.medication;o.listing.source_name='Legacy Incoming 20mg Tablets';o.listing.identity_candidate={name:'legacy incoming',strength:'20MG',form:'tablets',route:'oral',release_type:'immediate'};
 await withRun(id=>normalizedRepo.saveObservation(sourceId,id,o));
 const saved=(await worker.query('select medication_id,match_status,metadata from pricing.listings where id=$1',[listing.id])).rows[0];
 assert.equal(resolverCalls,0);assert.equal(saved.medication_id,medication.id);assert.equal(saved.match_status,'verified');assert.equal(saved.metadata.legacy_marker,'keep');assert.equal(saved.metadata.normalization,undefined);
 const canonical=(await worker.query('select normalized_key,normalization_status from pricing.medications where id=$1',[medication.id])).rows[0];assert.equal(canonical.normalized_key,null);assert.equal(canonical.normalization_status,null);
 assert.equal((await worker.query('select count(*)::int n from pricing.medication_matches where listing_id=$1',[listing.id])).rows[0].n,0);
});

test('incoming pharmacy variants normalize end to end through pricing API into MedAPI',async()=>{
 const resolver:TerminologyResolver={resolve:async()=>({method:'rxnorm_normalized',version:'08-Sep-2026',concepts:[{rxcui:'314077',name:'lisinopril 20 MG Oral Tablet',tty:'SCD'}]})};
 const normalizedRepo=new Repository(worker,new MedicationNormalizer(resolver));
 const make=(key:string,name:string,strength:string,form:string,seller:'healthwarehouse'|'costplus'):Observation=>({listing:{source_product_key:key,source_name:`${name} ${strength} ${form}`,url:`https://www.${seller==='healthwarehouse'?'healthwarehouse.com':'costplusdrugs.com'}/incoming-${key}`,brand_name:null,sold_as:form,content_quantity:'1',content_unit:form,identity_candidate:{name,strength,form,route:'oral',release_type:'immediate',brand_name:null,ndc:seller==='costplus'?'68180098103':null,species:[]},metadata:{}},offers:[{quantity:'90',price_cents:seller==='healthwarehouse'?'1260':'666',currency:'USD',availability:'in_stock',seller_key:seller,location_key:'online-us',program_key:'cash',terms:{quote_kind:'source_product_total'},valid_until:null,active:true}],observed_at:new Date().toISOString(),evidence_path:`local://incoming-${key}.json`,complete:true});
 const cp=(await normalizedRepo.source('costplus')).id;
 const first=await withSourceRun(sourceId,id=>normalizedRepo.saveObservation(sourceId,id,make('hw-normalized','LISINOPRIL','20MG','tablets','healthwarehouse')));
 const second=await withSourceRun(cp,id=>normalizedRepo.saveObservation(cp,id,make('cp-normalized','lisinopril','20 mg','tablet','costplus')));
 const rows=(await worker.query('select id,medication_id,match_status,content_unit from pricing.listings where id=any($1::bigint[]) order by id',[[first.listingId,second.listingId]])).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].medication_id,rows[1].medication_id);assert.ok(rows.every(x=>x.match_status==='verified'&&x.content_unit==='tablet'));
 const medication=(await worker.query("select * from pricing.medications where rxnorm_rxcui='314077'")).rows;assert.equal(medication.length,1);assert.equal(medication[0].canonical_name,'lisinopril 20 MG Oral Tablet');assert.equal(medication[0].normalization_version,'1');
 const components=(await worker.query('select * from pricing.medication_components where medication_id=$1',[rows[0].medication_id])).rows;assert.equal(components.length,1);assert.equal(components[0].numerator_value,'20');assert.equal(components[0].numerator_unit,'mg');
 const matches=(await worker.query('select match_status,match_method,input_hash from pricing.medication_matches where listing_id=any($1::bigint[]) order by listing_id',[[first.listingId,second.listingId]])).rows;assert.equal(matches.length,2);assert.ok(matches.every(x=>x.match_status==='verified'&&x.match_method==='rxnorm_normalized'&&/^[0-9a-f]{64}$/.test(x.input_hash)));
 await assert.rejects(admin.query('update pricing.medication_matches set reason=null where listing_id=$1',[first.listingId]),/append-only/);await assert.rejects(admin.query('delete from pricing.medication_matches where listing_id=$1',[first.listingId]),/append-only/);
 const search=await apiGet('/v1/medications?q=lisinopril');assert.equal(search.statusCode,200,search.body);assert.equal(search.json().items.length,1);assert.equal(search.json().items[0].rxnorm_rxcui,'314077');assert.deepEqual(search.json().items[0].components.map((x:any)=>[x.ingredient_name,x.numerator_value,x.numerator_unit]),[['lisinopril','20','mg']]);
 const offers=await apiGet(`/v1/medications/${rows[0].medication_id}/offers?quantity=90&unit=tablet`);assert.equal(offers.statusCode,200,offers.body);assert.deepEqual(offers.json().items.map((x:any)=>x.source).sort(),['costplus','healthwarehouse']);assert.equal(offers.json().medication.normalization_status,'verified');
 const status=(await apiGet('/v1/sources/status')).json();assert.equal(status.sources.find((x:any)=>x.source==='healthwarehouse').normalized_verified_listings>=1,true);assert.equal(status.sources.find((x:any)=>x.source==='costplus').normalized_verified_listings>=1,true);
});

test('a terminology outage reuses an unchanged verified incoming match without weakening it',async()=>{
 const input={name:'outage-lisinopril',strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate',brand_name:null,ndc:null,species:[]};
 const resolved=new Repository(worker,new MedicationNormalizer({resolve:async()=>({method:'rxnorm_normalized',version:'fixture',concepts:[{rxcui:'999314077',name:'outage-lisinopril 20 MG Oral Tablet',tty:'SCD'}]})}));
 const o=observation('normalization-outage');delete o.listing.medication;o.listing.identity_candidate=input;o.listing.source_name='Outage Lisinopril 20mg Tablets';
 const saved=await withRun(id=>resolved.saveObservation(sourceId,id,o));
 o.observed_at=new Date(Date.now()+1000).toISOString();o.offers[0].price_cents='975';
 const unavailable=new Repository(worker,new MedicationNormalizer({resolve:async()=>{throw Error('offline');}}));
 await withRun(id=>unavailable.saveObservation(sourceId,id,o));
 const listing=(await worker.query('select match_status,metadata from pricing.listings where id=$1',[saved.listingId])).rows[0];assert.equal(listing.match_status,'verified');assert.equal(listing.metadata.normalization.status,'verified');assert.equal((await worker.query('select price_cents from pricing.offers where listing_id=$1',[saved.listingId])).rows[0].price_cents,'975');assert.equal((await worker.query('select count(*)::int n from pricing.medication_matches where listing_id=$1',[saved.listingId])).rows[0].n,1);
});
test('discovery is idempotent and does not reset successful processing',async()=>{const url='https://www.healthwarehouse.com/test-page';await repo.discover(sourceId,[{url,from:null,reason:null}]);const id=(await worker.query('select id from pricing.crawl_pages where url=$1',[url])).rows[0].id;await repo.pageResult(id,'product','success',true);const a=(await worker.query('select * from pricing.crawl_pages where id=$1',[id])).rows[0];await repo.discover(sourceId,[{url,from:'https://www.healthwarehouse.com/another',reason:null}]);const b=(await worker.query('select * from pricing.crawl_pages where id=$1',[id])).rows[0];assert.deepEqual(a.next_crawl_at,b.next_crawl_at);assert.deepEqual(a.last_success_at,b.last_success_at);assert.equal(b.discovered_from,null);});
test('new, unchanged, changed, repeated, and returning prices have correct history',async()=>{const o=observation();const a=await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(await count(a.listingId),1);await withRun(async id=>{await repo.saveObservation(sourceId,id,o);await repo.saveObservation(sourceId,id,o);});assert.equal(await count(a.listingId),1);o.offers[0].price_cents='950';o.observed_at=new Date(Date.now()+1000).toISOString();await withRun(async id=>{await repo.saveObservation(sourceId,id,o);await repo.saveObservation(sourceId,id,o);});assert.equal(await count(a.listingId),2);o.offers[0].price_cents='900';o.observed_at=new Date(Date.now()+2000).toISOString();await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(await count(a.listingId),3);});
test('an older observation cannot overwrite current state',async()=>{const o=observation();o.observed_at=new Date(Date.now()+5000).toISOString();const a=await withRun(id=>repo.saveObservation(sourceId,id,o));o.observed_at=new Date().toISOString();o.offers[0].price_cents='1';const result=await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(result.ignored,'older_observation');assert.equal((await worker.query('select price_cents from pricing.offers where listing_id=$1',[a.listingId])).rows[0].price_cents,'900');assert.equal(await count(a.listingId),1);});
test('conflicting second state in one run rolls back',async()=>{const o=observation();await withRun(async id=>{const a=await repo.saveObservation(sourceId,id,o);o.offers[0].price_cents='1000';await assert.rejects(repo.saveObservation(sourceId,id,o),/CONFLICTING_STATES/);assert.equal((await worker.query('select price_cents from pricing.offers where listing_id=$1',[a.listingId])).rows[0].price_cents,'900');assert.equal(await count(a.listingId),1);});});
test('price history cannot be modified, and run sources must match',async()=>{await assert.rejects(worker.query('update pricing.offer_history set price_cents=0'),{code:'42501'});await assert.rejects(admin.query('update pricing.offer_history set price_cents=0'),/append-only/);const o=observation();await withRun(async id=>{const cp=(await repo.source('costplus')).id;await assert.rejects(repo.saveObservation(cp,id,o),/INVALID_OBSERVATION_RUN/);});});
test('identity changes are quarantined without rewriting historical context',async()=>{const o=observation();const a=await withRun(id=>repo.saveObservation(sourceId,id,o));o.listing.source_name='Different Drug 50mg';const result=await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(result.ignored,'identity_conflict');assert.equal((await worker.query('select match_status from pricing.listings where id=$1',[a.listingId])).rows[0].match_status,'needs_review');assert.equal((await worker.query('select snapshot from pricing.offer_history h join pricing.offers o on o.id=h.offer_id where o.listing_id=$1',[a.listingId])).rows[0].snapshot.package.source_name,'Lisinopril Test 20mg Tablets');});
test('canonical identity changes are quarantined even when the source title and package do not change',async()=>{
 for(const [field,value] of Object.entries({name:'different-ingredient',strength:'40 mg',form:'capsule',route:'topical',release_type:'extended'})){
  const o=observation();const a=await withRun(id=>repo.saveObservation(sourceId,id,o));
  const listing=(await worker.query('select medication_id from pricing.listings where id=$1',[a.listingId])).rows[0];
  const before=(await worker.query('select * from pricing.offers where listing_id=$1',[a.listingId])).rows;
  const medicationCount=(await worker.query('select count(*)::int n from pricing.medications')).rows[0].n;
  o.listing.medication={...o.listing.medication!,[field]:value};o.offers[0].price_cents='1';o.evidence_path='local://identity-conflict.json';
  const result=await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(result.ignored,'identity_conflict',field);
  const after=(await worker.query('select medication_id,match_status,metadata from pricing.listings where id=$1',[a.listingId])).rows[0];
  assert.equal(after.medication_id,listing.medication_id,field);assert.equal(after.match_status,'needs_review');assert.equal(after.metadata.identity_conflict_evidence,o.evidence_path);
  assert.deepEqual((await worker.query('select * from pricing.offers where listing_id=$1',[a.listingId])).rows,before);assert.equal(await count(a.listingId),1);
  assert.equal((await worker.query('select count(*)::int n from pricing.medications')).rows[0].n,medicationCount);
  assert.equal((await apiGet(`/v1/medications/${listing.medication_id}/offers`)).json().items.length,0);
 }
});
test('initial canonical matching and rechecks of the same identity remain allowed',async()=>{
 const o=observation(),medication=o.listing.medication!;delete o.listing.medication;
 const a=await withRun(id=>repo.saveObservation(sourceId,id,o));
 assert.equal((await worker.query('select match_status from pricing.listings where id=$1',[a.listingId])).rows[0].match_status,'unmatched');
 o.listing.medication=medication;assert.equal((await withRun(id=>repo.saveObservation(sourceId,id,o))).ignored,undefined);
 o.offers[0].price_cents='950';assert.equal((await withRun(id=>repo.saveObservation(sourceId,id,o))).ignored,undefined);
 assert.equal((await worker.query('select match_status from pricing.listings where id=$1',[a.listingId])).rows[0].match_status,'verified');assert.equal(await count(a.listingId),2);
});
test('API requires authentication and supports source status',async()=>{const app=buildApi(reader,token);try{assert.equal((await app.inject('/v1/sources/status')).statusCode,401);}finally{await app.close();}const res=await apiGet('/v1/sources/status');assert.equal(res.statusCode,200,res.body);assert.equal(res.json().sources.length,2);assert.ok(!res.body.includes('evidence_path'));});
test('API matches exact physical quantities and excludes stale and expired offers',async()=>{const o=observation();o.listing.sold_as='pack';o.listing.content_quantity='50';o.offers[0].quantity='2';o.offers[0].price_cents='16000';const a=await withRun(id=>repo.saveObservation(sourceId,id,o));const med=(await worker.query('select medication_id from pricing.listings where id=$1',[a.listingId])).rows[0].medication_id;const exact=await apiGet(`/v1/medications/${med}/offers?quantity=100&unit=tablet`);assert.equal(exact.statusCode,200,exact.body);assert.equal(exact.json().items.length,1);assert.equal(exact.json().items[0].price_cents,'16000');assert.equal((await apiGet(`/v1/medications/${med}/offers?quantity=60&unit=tablet`)).json().items.length,0);assert.equal((await apiGet(`/v1/medications/${med}/offers?quantity=0&unit=tablet`)).statusCode,400);assert.equal((await apiGet(`/v1/medications/${med}/offers?quantity=100`)).statusCode,400);o.offers[0].valid_until=new Date(Date.now()-1000).toISOString();await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal((await apiGet(`/v1/medications/${med}/offers`)).json().items.length,0);});
test('partial extraction does not retire absent quantities, complete extraction does',async()=>{const o=observation();o.offers.push({...o.offers[0],quantity:'90',price_cents:'1260'});const a=await withRun(id=>repo.saveObservation(sourceId,id,o));o.offers.pop();o.complete=false;await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal((await worker.query('select count(*)::int n from pricing.offers where listing_id=$1 and active',[a.listingId])).rows[0].n,2);o.complete=true;await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal((await worker.query('select count(*)::int n from pricing.offers where listing_id=$1 and active',[a.listingId])).rows[0].n,1);});

test('unavailable, unknown, retired, and stale quotes never become current offers',async()=>{
 const o=observation();o.offers.push(
  {...o.offers[0],quantity:'60',availability:'out_of_stock'},
  {...o.offers[0],quantity:'90',availability:'unknown'},
  {...o.offers[0],quantity:'120',active:false});
 const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));
 const med=(await worker.query('select medication_id from pricing.listings where id=$1',[saved.listingId])).rows[0].medication_id;
 let res=(await apiGet(`/v1/medications/${med}/offers`)).json();assert.equal(res.items.length,1);
 assert.deepEqual(res.exclusions.filter((x:any)=>x.source==='healthwarehouse').map((x:any)=>x.reason).sort(),['out_of_stock','retired','unknown']);
 res=(await apiGet(`/v1/medications/${med}/offers?quantity=30&unit=tablet`)).json();assert.equal(res.items.length,1);assert.ok(!res.exclusions.some((x:any)=>x.source==='healthwarehouse'));
 const stale=observation();stale.observed_at=new Date(Date.now()-25*3600000).toISOString();const staleSaved=await withRun(id=>repo.saveObservation(sourceId,id,stale));
 const staleMed=(await worker.query('select medication_id from pricing.listings where id=$1',[staleSaved.listingId])).rows[0].medication_id;
 res=(await apiGet(`/v1/medications/${staleMed}/offers`)).json();assert.equal(res.items.length,0);assert.ok(res.exclusions.some((x:any)=>x.reason==='stale_or_expired'));
});
test('a failed crawl cannot refresh or erase the last successful price',async()=>{
 const o=observation();const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));
 const before=(await worker.query('select * from pricing.offers where listing_id=$1',[saved.listingId])).rows;
 await repo.discover(sourceId,[{url:o.listing.url,from:null,reason:null}]);const page=(await worker.query('select id from pricing.crawl_pages where source_id=$1 and url=$2',[sourceId,o.listing.url])).rows[0];
 await repo.pageResult(page.id,'product','success',true);const success=(await worker.query('select last_success_at from pricing.crawl_pages where id=$1',[page.id])).rows[0].last_success_at;
 await repo.pageResult(page.id,'product','blocked',false);
 assert.deepEqual((await worker.query('select * from pricing.offers where listing_id=$1',[saved.listingId])).rows,before);
 assert.deepEqual((await worker.query('select last_success_at from pricing.crawl_pages where id=$1',[page.id])).rows[0].last_success_at,success);
});
test('API pagination and membership context keep offers distinct',async()=>{
 const o=observation();o.offers.push({...o.offers[0],program_key:'member',price_cents:'700'});const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));
 const med=(await worker.query('select medication_id from pricing.listings where id=$1',[saved.listingId])).rows[0].medication_id;
 const first=(await apiGet(`/v1/medications/${med}/offers?limit=1`)).json();assert.equal(first.items.length,1);assert.ok(first.next_cursor);
 const second=(await apiGet(`/v1/medications/${med}/offers?limit=1&cursor=${first.next_cursor}`)).json();assert.equal(second.items.length,1);assert.notEqual(first.items[0].offer_id,second.items[0].offer_id);assert.equal(second.next_cursor,null);
 const member=(await apiGet(`/v1/medications/${med}/offers?program=member&location=online-us`)).json();assert.equal(member.items.length,1);assert.equal(member.items[0].price_cents,'700');
 assert.equal((await apiGet(`/v1/medications/${med}/offers?limit=101`)).statusCode,400);
 assert.equal((await apiGet(`/v1/medications/${med}/offers?cursor=1%27`)).statusCode,400);
});
test('anonymous and authenticated app roles cannot read the pricing schema',async()=>{
 for(const role of ['anon','authenticated']){await admin.query(`set role ${role}`);try{await assert.rejects(admin.query('select * from pricing.offers'),{code:'42501'});}finally{await admin.query('reset role');}}
});

test('the actual collector CLI persists quantity outcomes and preserves prices on a blocked follow-up',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');
 const dir=await mkdtemp(resolve('.cache/cli-test-'));const url='https://www.healthwarehouse.com/cli-test-product';
 await repo.discover(sourceId,[{url,from:null,reason:null}]);const page=(await worker.query('select id from pricing.crawl_pages where source_id=$1 and url=$2',[sourceId,url])).rows[0];
 const fixture=JSON.parse(await readFile('tests/fixtures/healthwarehouse-lisinopril.json','utf8'));const file=dir+'/manifest.json';
 await writeFile(file,JSON.stringify({inventory_audit_passed:false,listings:[{source:'healthwarehouse',page_id:page.id,url,source_product_key:'CLI-TEST',planned_quantities:fixture.expected.quantities}]}));
 const env={...process.env,DATABASE_URL:`postgresql://housemed_worker@localhost/housemed_test?host=${encodeURIComponent(host)}&port=${port}`,SUPABASE_SECRET_KEY:'',SUPABASE_PROJECT_REF:'test',HOUSEMED_RXNORM_DISABLED:'1'};
 try{
  const first=spawnSync(process.execPath,['--import','tsx','tests/fixtures/collector-driver.mjs',file],{env,encoding:'utf8',timeout:15000});assert.equal(first.status,0,first.stdout+first.stderr);
  const run=(await worker.query('select * from pricing.crawl_runs where source_id=$1 order by id desc limit 1',[sourceId])).rows[0];
  assert.equal(run.status,'succeeded');assert.equal(run.summary.scope,'access_test');assert.equal(run.summary.successful_listings,1);assert.equal(run.summary.successful_quantity_checks,fixture.expected.quantities.length);assert.equal(run.checkpoint.manifest_index,1);
  const old=(await worker.query("select o.* from pricing.offers o join pricing.listings l on l.id=o.listing_id where l.source_product_key='CLI-TEST' order by o.id")).rows;
  const blocked=spawnSync(process.execPath,['--import','tsx','tests/fixtures/collector-driver.mjs',file,'blocked'],{env,encoding:'utf8',timeout:15000});assert.equal(blocked.status,1,blocked.stdout+blocked.stderr);
  const failed=(await worker.query('select * from pricing.crawl_runs where source_id=$1 order by id desc limit 1',[sourceId])).rows[0];assert.equal(failed.summary.source_paused,true);assert.equal(failed.summary.planned_quantity_checks,fixture.expected.quantities.length);assert.equal(failed.summary.successful_quantity_checks,0);assert.equal(failed.checkpoint.collection_results[page.id].reason,'SOURCE_BLOCKED');
  assert.deepEqual((await worker.query("select o.* from pricing.offers o join pricing.listings l on l.id=o.listing_id where l.source_product_key='CLI-TEST' order by o.id")).rows,old);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('recurring discovery revisits due pages once while initial discovery leaves successful pages intact',async()=>{
 const sourceId=(await repo.source('costplus')).id;
 const items=['known','missing','new'].map(x=>({url:'https://www.costplusdrugs.com/recurring-'+x,from:null,reason:null}));await repo.discover(sourceId,items);
 const rows=(await worker.query("select id,url from pricing.crawl_pages where url like 'https://www.costplusdrugs.com/recurring-%'")).rows;
 const known=rows.find(x=>x.url.endsWith('known')),missing=rows.find(x=>x.url.endsWith('missing')),fresh=rows.find(x=>x.url.endsWith('new'));
 await repo.pageResult(known.id,'content','success',true);await repo.pageResult(missing.id,'unknown','not_found',false);
 await worker.query("update pricing.crawl_pages set next_crawl_at=now()-interval '1 day' where id=any($1::bigint[])",[[known.id,missing.id]]);
 assert.equal((await repo.nextDiscovery(sourceId,'https://www.costplusdrugs.com',null)).id,fresh.id);
 await repo.pageResult(fresh.id,'content','success',true);assert.equal(await repo.nextDiscovery(sourceId,'https://www.costplusdrugs.com',null),null);
 const cutoff=new Date().toISOString();assert.equal(await repo.remainingDiscovery(sourceId,cutoff),2);
 assert.equal((await repo.nextDiscovery(sourceId,'https://www.costplusdrugs.com',cutoff)).id,known.id);await repo.pageResult(known.id,'content','success',true);
 assert.equal((await repo.nextDiscovery(sourceId,'https://www.costplusdrugs.com',cutoff)).id,missing.id);await repo.pageResult(missing.id,'unknown','not_found',false);
 assert.equal(await repo.remainingDiscovery(sourceId,cutoff),0);
});

test('API collection proceeds independently of a website pause and does not claim a website visit',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');const cp=(await repo.source('costplus')).id;
 const f=JSON.parse(await readFile('tests/fixtures/costplus-lisinopril-api.json','utf8'));await repo.discover(cp,[{url:f.url,from:null,reason:null}]);const page=(await worker.query('select id from pricing.crawl_pages where source_id=$1 and url=$2',[cp,f.url])).rows[0];
 await worker.query("insert into pricing.crawl_runs(source_id,parser_version,status,started_at,finished_at,checkpoint,summary) values($1,'test','failed',now(),now(),$2,$3)",[cp,JSON.stringify({phase:'discover'}),JSON.stringify({source_paused:true,access_channel:'website',reason:'SOURCE_BLOCKED'})]);
 const dir=await mkdtemp(resolve('.cache/cp-cli-'));const file=dir+'/manifest.json';await writeFile(file,JSON.stringify({inventory_audit_passed:false,listings:[{source:'costplus',page_id:page.id,url:f.url,planned_quantities:['30','90']}]}));
 try{const result=spawnSync(process.execPath,['--import','tsx','tests/fixtures/costplus-driver.mjs',file],{encoding:'utf8',timeout:15000,env:{...process.env,DATABASE_URL:`postgresql://housemed_worker@localhost/housemed_test?host=${encodeURIComponent(host)}&port=${port}`,SUPABASE_SECRET_KEY:'',SUPABASE_PROJECT_REF:'test',HOUSEMED_RXNORM_DISABLED:'1'}});assert.equal(result.status,0,result.stdout+result.stderr);
  const run=(await worker.query('select * from pricing.crawl_runs where source_id=$1 order by id desc limit 1',[cp])).rows[0];assert.equal(run.summary.access_channel,'api');assert.equal(run.summary.validated_price_quotes,2);assert.equal(run.summary.successful_quantity_checks,2);
  assert.equal((await worker.query('select last_success_at from pricing.crawl_pages where id=$1',[page.id])).rows[0].last_success_at,null);
  const website=(await worker.query("select summary from pricing.crawl_runs where source_id=$1 and summary->>'access_channel'='website' order by id desc limit 1",[cp])).rows[0];assert.equal(website.summary.source_paused,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('estimate opt-in preserves unknown availability and strict default eligibility',async()=>{
 const o=observation();o.offers[0].availability='unknown';o.offers[0].terms={quote_kind:'estimate',availability_basis:'not_provided_by_api',shipping:null};
 const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));const med=(await worker.query('select medication_id from pricing.listings where id=$1',[saved.listingId])).rows[0].medication_id;
 assert.equal((await apiGet(`/v1/medications/${med}/offers`)).json().items.length,0);
 const estimate=(await apiGet(`/v1/medications/${med}/offers?include_estimates=true&quantity=30&unit=tablet`)).json();assert.equal(estimate.items.length,1);assert.equal(estimate.items[0].availability,'unknown');assert.equal(estimate.items[0].purchase_verification_required,true);assert.equal(estimate.quote_status,'includes_unconfirmed_estimates');assert.ok(!estimate.exclusions.some((x:any)=>x.source==='healthwarehouse'&&x.reason==='unknown'));
 o.offers[0].valid_until=new Date(Date.now()-1000).toISOString();await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal((await apiGet(`/v1/medications/${med}/offers?include_estimates=true`)).json().items.length,0);
 o.offers[0].valid_until=null;o.offers[0].terms={};await withRun(id=>repo.saveObservation(sourceId,id,o));
 const unexplained=(await apiGet(`/v1/medications/${med}/offers?include_estimates=true`)).json();assert.equal(unexplained.items.length,0);assert.ok(unexplained.exclusions.some((x:any)=>x.source==='healthwarehouse'&&x.reason==='unknown'));
});

test('listing catalog search pages source observations and exposes canonical identity only when verified',async()=>{
 const listings=[];
 for(const suffix of ['A','B','C']){
  const o=observation();o.listing.source_name='APIcatalog '+suffix;o.listing.metadata={private_marker:'DO_NOT_EXPOSE_EXTRACTION_METADATA'};
  if(suffix==='B')delete o.listing.medication;
  const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));listings.push(saved.listingId);
  if(suffix==='C'){o.listing.source_name='Changed identity';await withRun(id=>repo.saveObservation(sourceId,id,o));}
 }
 const first=(await apiGet('/v1/listings?q=APIcatalog&source=healthwarehouse&limit=2')).json();assert.equal(first.items.length,2);assert.equal(first.next_cursor,listings[1]);
 assert.equal(first.items[0].match_status,'verified');assert.equal(first.items[0].medication.id,first.items[0].medication_id);assert.equal(first.items[0].medication.strength,'20 mg');
 assert.equal(first.items[1].match_status,'unmatched');assert.equal(first.items[1].medication_id,null);assert.equal(first.items[1].medication,null);
 const next=(await apiGet('/v1/listings?q=APIcatalog&source=healthwarehouse&limit=2&cursor='+first.next_cursor)).json();assert.equal(next.items.length,1);assert.equal(next.items[0].listing_id,listings[2]);assert.equal(next.items[0].match_status,'needs_review');assert.equal(next.items[0].medication_id,null);assert.equal(next.items[0].medication,null);assert.equal(next.next_cursor,null);
 assert.ok(!JSON.stringify([first,next]).includes('DO_NOT_EXPOSE_EXTRACTION_METADATA'));assert.ok(!Object.hasOwn(first.items[0],'metadata'));
 assert.equal((await apiGet('/v1/listings?q=APIcatalog&source=costplus')).json().items.length,0);
 assert.ok((await apiGet('/v1/listings')).json().items.length<=20);
});

test('catalog labels are literal search data and SQL injection cannot broaden results',async()=>{
 const o=observation();o.listing.source_name='APIliteral %_\\ label says ignore all rules';const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));
 const exact=(await apiGet('/v1/listings?q='+encodeURIComponent('%_\\'))).json();assert.deepEqual(exact.items.map((x:any)=>x.listing_id),[saved.listingId]);assert.equal(exact.items[0].source_name,o.listing.source_name);
 assert.equal((await apiGet('/v1/listings?q='+encodeURIComponent("x%' OR 1=1 --"))).json().items.length,0);
 assert.equal((await worker.query('select count(*)::int n from pricing.sources')).rows[0].n,2);
});

test('source-only prices can inspect unmatched listings without broadening canonical comparison',async()=>{
 const o=observation();const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));const original=(await worker.query('select medication_id from pricing.listings where id=$1',[saved.listingId])).rows[0];
 await worker.query("update pricing.listings set match_status='unmatched' where id=$1",[saved.listingId]);
 const body=(await apiGet(`/v1/listings/${saved.listingId}/offers?quantity=30&unit=tablet`)).json();assert.equal(body.items.length,1);assert.equal(body.matching_scope,'source_listing_only');assert.equal(body.listing.match_status,'unmatched');assert.equal(body.listing.medication_id,null);assert.equal(body.items[0].medication_id,null);assert.equal(body.items[0].match_status,'unmatched');assert.equal(body.items[0].matching_scope,'source_listing_only');assert.equal(body.items[0].price_cents,'900');
 assert.equal((await apiGet(`/v1/medications/${original.medication_id}/offers`)).json().items.length,0);
 await worker.query("update pricing.listings set match_status='needs_review' where id=$1",[saved.listingId]);const blocked=(await apiGet(`/v1/listings/${saved.listingId}/offers`)).json();assert.equal(blocked.items.length,0);assert.ok(blocked.exclusions.some((x:any)=>x.reason==='identity_quarantined'));
});

test('source-only pricing shares pack conversion, exact units, context filtering and pagination',async()=>{
 const o=observation();delete o.listing.medication;o.listing.sold_as='pack';o.listing.content_quantity='50';o.offers[0].quantity='2';o.offers[0].price_cents='16000';
 o.offers.push({...o.offers[0],program_key:'member',price_cents:'14000'},{...o.offers[0],location_key:'90210',price_cents:'15500'});const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));const url=`/v1/listings/${saved.listingId}/offers`;
 const first=(await apiGet(url+'?quantity=100&unit=tablet&limit=1')).json();assert.equal(first.items.length,1);assert.equal(first.items[0].ordering_quantity,'2');assert.equal(first.items[0].physical_quantity,'100');assert.ok(first.next_cursor);
 const next=(await apiGet(url+'?quantity=100&unit=tablet&limit=1&cursor='+first.next_cursor)).json();assert.equal(next.items.length,1);assert.notEqual(next.items[0].offer_id,first.items[0].offer_id);
 const member=(await apiGet(url+'?quantity=100&unit=tablet&program=member&location=online-us')).json();assert.equal(member.items.length,1);assert.equal(member.items[0].price_cents,'14000');
 for(const suffix of ['?quantity=60&unit=tablet','?quantity=100&unit=ml','?source=costplus','?program='+encodeURIComponent("cash' OR 1=1 --"),'?location=10000'])assert.equal((await apiGet(url+suffix)).json().items.length,0,suffix);
 const unresolved=observation();delete unresolved.listing.medication;unresolved.listing.content_quantity=null;unresolved.listing.content_unit=null;const unknown=await withRun(id=>repo.saveObservation(sourceId,id,unresolved));const excluded=(await apiGet(`/v1/listings/${unknown.listingId}/offers`)).json();assert.equal(excluded.items.length,0);assert.ok(excluded.exclusions.some((x:any)=>x.reason==='packaging_unresolved'));
});

test('source-only inspection preserves stale, expiry, stock and estimate restrictions',async()=>{
 const o=observation();delete o.listing.medication;
 o.offers.push({...o.offers[0],quantity:'60',availability:'out_of_stock'},{...o.offers[0],quantity:'90',availability:'unknown'},{...o.offers[0],quantity:'120',availability:'unknown',terms:{quote_kind:'estimate',availability_basis:'not_provided_by_api'}},{...o.offers[0],quantity:'180',valid_until:new Date(Date.now()-1000).toISOString()});
 const saved=await withRun(id=>repo.saveObservation(sourceId,id,o));const url=`/v1/listings/${saved.listingId}/offers`;
 const strict=(await apiGet(url)).json();assert.equal(strict.items.length,1);assert.deepEqual(strict.exclusions.map((x:any)=>x.reason).sort(),['out_of_stock','stale_or_expired','unknown']);
 const opted=(await apiGet(url+'?include_estimates=true')).json();assert.equal(opted.items.length,2);assert.equal(opted.quote_status,'includes_unconfirmed_estimates');assert.equal(opted.items.find((x:any)=>x.ordering_quantity==='120').purchase_verification_required,true);assert.ok(!opted.items.some((x:any)=>x.ordering_quantity==='90'));
 const stale=observation();delete stale.listing.medication;stale.observed_at=new Date(Date.now()-25*3600000).toISOString();const old=await withRun(id=>repo.saveObservation(sourceId,id,stale));const expired=(await apiGet(`/v1/listings/${old.listingId}/offers?include_estimates=true`)).json();assert.equal(expired.items.length,0);assert.ok(expired.exclusions.some((x:any)=>x.reason==='stale_or_expired'));
});

test('listing APIs enforce input bounds and return safe not-found and outage errors',async()=>{
 for(const path of ['/v1/listings?limit=101','/v1/listings?limit=0','/v1/listings?cursor=1%27','/v1/listings?q=x','/v1/listings?q='+'x'.repeat(121),'/v1/listings?source=foreign','/v1/listings/0/offers','/v1/listings/1%27/offers','/v1/listings/1/offers?quantity=0&unit=tablet','/v1/listings/1/offers?quantity=30','/v1/listings/1/offers?quantity=1000001&unit=tablet','/v1/listings/1/offers?limit=101','/v1/listings/1/offers?include_estimates=maybe','/v1/listings/1/offers?location='+'a'.repeat(65)])assert.equal((await apiGet(path)).statusCode,400,path);
 const missing=await apiGet('/v1/listings/999999999999999999/offers');assert.equal(missing.statusCode,404);assert.deepEqual(missing.json(),{error:'listing_not_found'});
 const failed=buildApi({query:async()=>{throw Object.assign(Error('private credential details'),{code:'ECONNRESET'});}} as unknown as pg.Pool,token);
 try{for(const path of ['/v1/listings','/v1/listings/1/offers']){const result=await failed.inject({url:path,headers:{authorization:'Bearer '+token}});assert.equal(result.statusCode,503);assert.deepEqual(result.json(),{error:'service_unavailable'});}assert.equal((await failed.inject('/v1/listings')).statusCode,401);}finally{await failed.close();}
});
