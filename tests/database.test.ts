import {before,after,test} from 'node:test';import assert from 'node:assert/strict';
import pg from 'pg';import {readFile,readdir} from 'node:fs/promises';import {resolve} from 'node:path';
import {Repository} from '../src/repository.js';import {buildApi} from '../src/api.js';import type {Observation,Quote} from '../src/core.js';
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
function observation(key='product-'+(++sequence)):Observation{return {listing:{source_product_key:key,source_name:'Lisinopril Test 20mg Tablets',url:'https://www.healthwarehouse.com/'+key,brand_name:null,sold_as:'tablet',content_quantity:'1',content_unit:'tablet',medication:{name:'lisinopril-test-'+key,strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate'},metadata:{}},offers:[{quantity:'30',price_cents:'900',currency:'USD',availability:'in_stock',seller_key:'healthwarehouse',location_key:'online-us',program_key:'cash',terms:{quote_kind:'source_product_total',shipping:null},valid_until:null,active:true}],observed_at:new Date().toISOString(),evidence_path:'local://test.json',complete:true};}
const count=async(listing:string)=>(await admin.query('select count(*)::int as n from pricing.offer_history h join pricing.offers o on o.id=h.offer_id where o.listing_id=$1',[listing])).rows[0].n;
async function apiGet(path:string){const app=buildApi(reader,token);try{return await app.inject({url:path,headers:{authorization:'Bearer '+token}});}finally{await app.close();}}
test('seven tables and private access boundaries',async()=>{assert.equal((await admin.query("select count(*)::int as n from information_schema.tables where table_schema='pricing' and table_type='BASE TABLE'")).rows[0].n,7);await assert.rejects(reader.query("update pricing.sources set name='bad'"),{code:'42501'});await assert.rejects(reader.query('select evidence_path from pricing.crawl_runs'),{code:'42501'});await admin.query('set role anon');try{await assert.rejects(admin.query('select * from pricing.offers'),{code:'42501'});}finally{await admin.query('reset role');}});
test('discovery is idempotent and does not reset successful processing',async()=>{const url='https://www.healthwarehouse.com/test-page';await repo.discover(sourceId,[{url,from:null,reason:null}]);const id=(await worker.query('select id from pricing.crawl_pages where url=$1',[url])).rows[0].id;await repo.pageResult(id,'product','success',true);const a=(await worker.query('select * from pricing.crawl_pages where id=$1',[id])).rows[0];await repo.discover(sourceId,[{url,from:'https://www.healthwarehouse.com/another',reason:null}]);const b=(await worker.query('select * from pricing.crawl_pages where id=$1',[id])).rows[0];assert.deepEqual(a.next_crawl_at,b.next_crawl_at);assert.deepEqual(a.last_success_at,b.last_success_at);assert.equal(b.discovered_from,null);});
test('new, unchanged, changed, repeated, and returning prices have correct history',async()=>{const o=observation();const a=await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(await count(a.listingId),1);await withRun(async id=>{await repo.saveObservation(sourceId,id,o);await repo.saveObservation(sourceId,id,o);});assert.equal(await count(a.listingId),1);o.offers[0].price_cents='950';o.observed_at=new Date(Date.now()+1000).toISOString();await withRun(async id=>{await repo.saveObservation(sourceId,id,o);await repo.saveObservation(sourceId,id,o);});assert.equal(await count(a.listingId),2);o.offers[0].price_cents='900';o.observed_at=new Date(Date.now()+2000).toISOString();await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(await count(a.listingId),3);});
test('an older observation cannot overwrite current state',async()=>{const o=observation();o.observed_at=new Date(Date.now()+5000).toISOString();const a=await withRun(id=>repo.saveObservation(sourceId,id,o));o.observed_at=new Date().toISOString();o.offers[0].price_cents='1';const result=await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(result.ignored,'older_observation');assert.equal((await worker.query('select price_cents from pricing.offers where listing_id=$1',[a.listingId])).rows[0].price_cents,'900');assert.equal(await count(a.listingId),1);});
test('conflicting second state in one run rolls back',async()=>{const o=observation();await withRun(async id=>{const a=await repo.saveObservation(sourceId,id,o);o.offers[0].price_cents='1000';await assert.rejects(repo.saveObservation(sourceId,id,o),/CONFLICTING_STATES/);assert.equal((await worker.query('select price_cents from pricing.offers where listing_id=$1',[a.listingId])).rows[0].price_cents,'900');assert.equal(await count(a.listingId),1);});});
test('price history cannot be modified, and run sources must match',async()=>{await assert.rejects(worker.query('update pricing.offer_history set price_cents=0'),{code:'42501'});await assert.rejects(admin.query('update pricing.offer_history set price_cents=0'),/append-only/);const o=observation();await withRun(async id=>{const cp=(await repo.source('costplus')).id;await assert.rejects(repo.saveObservation(cp,id,o),/INVALID_OBSERVATION_RUN/);});});
test('identity changes are quarantined without rewriting historical context',async()=>{const o=observation();const a=await withRun(id=>repo.saveObservation(sourceId,id,o));o.listing.source_name='Different Drug 50mg';const result=await withRun(id=>repo.saveObservation(sourceId,id,o));assert.equal(result.ignored,'identity_conflict');assert.equal((await worker.query('select match_status from pricing.listings where id=$1',[a.listingId])).rows[0].match_status,'needs_review');assert.equal((await worker.query('select snapshot from pricing.offer_history h join pricing.offers o on o.id=h.offer_id where o.listing_id=$1',[a.listingId])).rows[0].snapshot.package.source_name,'Lisinopril Test 20mg Tablets');});
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
