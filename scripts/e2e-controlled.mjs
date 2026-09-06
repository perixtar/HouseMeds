import assert from 'node:assert/strict';import pg from 'pg';import {spawn} from 'node:child_process';import {createServer} from 'node:net';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';import {randomBytes} from 'node:crypto';

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),socket=join(root,'.cache/pgsock'),database='housemed_e2e_test',port=63814;
const started=new Date(),work=join(root,'data/audits/e2e-controlled',started.toISOString().replaceAll(':','-'));await mkdir(work,{recursive:true});
const token=randomBytes(24).toString('hex'),base=`http://127.0.0.1:${port}`,cases=[],children=[];
const report={scope:'controlled_failure_e2e',started_at:started.toISOString(),status:'running',database,http_origin:base,work_directory:work,acceptance_credit:false,cases,
 limitations:['Source page snapshots, source HTTP responses, and storage failures are controlled fixtures; these are not live pharmacy/browser checks.','The isolated local database uses production migrations and roles, but does not exercise Supabase TLS, live DNS, or cloud storage.','The stale case injects a collector clock offset; expiry is set in the isolated database because current adapters do not parse source expiry.','Pet labeling is fixture metadata, not veterinary suitability verification.','This run does not satisfy the final 200-listing audit, whole-site inventory, or seven-day reliability gates.']};
const dbUrl=role=>`postgresql://${role}@localhost/${database}?host=${encodeURIComponent(socket)}&port=65431`;
const childEnv={PATH:process.env.PATH??'',HOME:process.env.HOME??'',TMPDIR:process.env.TMPDIR??'/tmp',DATABASE_URL:dbUrl('housemed_worker'),READ_DATABASE_URL:dbUrl('housemed_reader'),HOUSEMED_API_TOKEN:token,HOST:'127.0.0.1',PORT:String(port),SUPABASE_SECRET_KEY:'',SUPABASE_PROJECT_REF:'housemed-e2e-fixture',HOUSEMED_E2E_SOCKET:socket,CRAWL_DELAY_MS:'5000',NODE_OPTIONS:''};
let admin,api,bootstrap,createdDatabase=false;
async function saveReport(){report.finished_at=new Date().toISOString();report.elapsed_ms=Date.now()-started.getTime();await mkdir(join(root,'data/reports'),{recursive:true});await writeFile(join(root,'data/reports/e2e-controlled.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
async function check(name,fn){const start=Date.now(),entry={name,status:'running',started_at:new Date().toISOString()};cases.push(entry);try{entry.details=await fn();entry.status='passed';}catch(e){entry.status='failed';entry.error={name:e.name,message:e.message,stack:e.stack};}entry.elapsed_ms=Date.now()-start;await saveReport();console.log(JSON.stringify({case:name,status:entry.status,elapsed_ms:entry.elapsed_ms}));}
async function http(path,{auth=true,method='GET',body}={}){const r=await fetch(base+path,{method,headers:{...(auth?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json()};}
const q=async(sql,values=[]) => (await admin.query(sql,values)).rows;
const sourceId=async source=>(await q('select id from pricing.sources where slug=$1',[source]))[0].id;
async function state(source,key){const listing=(await q('select l.* from pricing.listings l join pricing.sources s on s.id=l.source_id where s.slug=$1 and l.source_product_key=$2',[source,key]))[0];return {listing,offers:listing?await q('select * from pricing.offers where listing_id=$1 order by id',[listing.id]):[],history:listing?await q('select h.* from pricing.offer_history h join pricing.offers o on o.id=h.offer_id where o.listing_id=$1 order by h.id',[listing.id]):[]};}
const med={name:'e2e-lisinopril',strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate'};
const hwFixture=JSON.parse(await readFile(join(root,'tests/fixtures/healthwarehouse-lisinopril.json'),'utf8'));
const cpFixture=JSON.parse(await readFile(join(root,'tests/fixtures/costplus-lisinopril-api.json'),'utf8'));
function hw(key,options={}){
 const snapshot=structuredClone(hwFixture.snapshot);snapshot.product.sku=key;snapshot.panel=snapshot.panel.replace('*LISINOPRIL20',key);
 if(options.price30){const offer=snapshot.product.offers.find(x=>x.eligibleQuantity.value===30);offer.price=Number(options.price30)/100;offer.priceSpecification.price=offer.price;}
 if(options.missing90){snapshot.product.offers=snapshot.product.offers.filter(x=>x.eligibleQuantity.value!==90);snapshot.buttons=snapshot.buttons.filter(x=>x.label!=='Select quantity 90');}
 if(options.availability)for(const offer of snapshot.product.offers)offer.availability='https://schema.org/'+options.availability;
 return {source:'healthwarehouse',key,url:'https://www.healthwarehouse.com/e2e-'+key.toLowerCase(),snapshot,review:{medication:options.medication??med},planned_quantities:['28','30','60','90','180'],...options};
}
const cpKey='url:/medications/lisinopril-20mg-tablet/';
function cp(options={}){return {source:'costplus',key:cpKey,url:cpFixture.url,catalog:structuredClone(cpFixture.responses[0].response.results[0]),prices:{'30':'$5.55','90':'$6.66'},review:{medication:med},planned_quantities:['30','90'],...options};}
async function collect(label,scenario){
 const id=await sourceId(scenario.source);await q('insert into pricing.crawl_pages(source_id,url) values($1,$2) on conflict(source_id,url) do nothing',[id,scenario.url]);
 const page=(await q('select id from pricing.crawl_pages where source_id=$1 and url=$2',[id,scenario.url]))[0];
 const manifest={inventory_audit_passed:false,listings:[{source:scenario.source,page_id:page.id,url:scenario.url,source_product_key:scenario.key,planned_quantities:scenario.planned_quantities,review:scenario.review}]};
 const manifestFile=join(work,label+'.manifest.json'),scenarioFile=join(work,label+'.scenario.json');await writeFile(manifestFile,JSON.stringify(manifest));await writeFile(scenarioFile,JSON.stringify(scenario));
 const beforeRun=(await q('select coalesce(max(id),0)::text id from pricing.crawl_runs'))[0].id;
 const startedAt=Date.now();let stdout='',stderr='',faultObserved=false,visibleDuringTransaction,httpDuringTransaction,faultReadError,timedOut=false;
 const child=spawn(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(root,'tests/fixtures/e2e-collector-driver.mjs'),manifestFile,scenarioFile],{cwd:work,env:{...childEnv,SUPABASE_SECRET_KEY:scenario.evidence_failure?'fixture-key-not-a-real-credential':''},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
 child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
 child.on('message',async msg=>{if(msg.event==='transaction_open_before_history'){faultObserved=true;try{visibleDuringTransaction=await state(scenario.source,scenario.key);httpDuringTransaction=await offers(visibleDuringTransaction.listing.medication_id,'?quantity=30&unit=tablet&source='+scenario.source);}catch(e){faultReadError={message:e.message};}finally{child.kill('SIGKILL');}}});
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},20000);
 const result=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));});clearTimeout(timer);
 await writeFile(join(work,label+'.stdout.log'),stdout);await writeFile(join(work,label+'.stderr.log'),stderr);
 const runs=await q('select id,status,summary,checkpoint from pricing.crawl_runs where id>$1 order by id',[beforeRun]);
 const counts=stdout.split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x);}catch{return null;}}).find(x=>x?.event==='controlled_http_counts');
 return {...result,elapsed_ms:Date.now()-startedAt,runs,counts,faultObserved,visibleDuringTransaction,httpDuringTransaction,faultReadError,timedOut,stdout_log:join(work,label+'.stdout.log'),stderr_log:join(work,label+'.stderr.log')};
}
function collected(result,success=true){assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.runs.at(-1).summary.successful_listings,success?1:0);}
async function offers(medicationId,query=''){const response=await http(`/v1/medications/${medicationId}/offers${query}`);assert.equal(response.status,200);return response.body;}
try{
 await new Promise((done,reject)=>{const server=createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(done));});
 bootstrap=new pg.Pool({host:socket,port:65431,database:'postgres',max:1});assert.equal(resolve((await bootstrap.query('show data_directory')).rows[0].data_directory),join(root,'.cache/pg-test'));
 const roles=(await bootstrap.query("select rolname,rolcanlogin from pg_roles where rolname=any($1)",[['housemed_worker','housemed_reader','anon','authenticated','service_role']])).rows;
 assert.equal(roles.length,5,'Prepare the local test roles before running this E2E; this script never changes shared roles.');for(const name of ['housemed_worker','housemed_reader'])assert.equal(roles.find(x=>x.rolname===name).rolcanlogin,true);
 await bootstrap.query(`drop database if exists ${database} with(force)`);await bootstrap.query(`create database ${database}`);createdDatabase=true;await bootstrap.end();bootstrap=null;
 admin=new pg.Pool({host:socket,port:65431,database,max:2});
 for(const file of (await readdir(join(root,'supabase/migrations'))).filter(x=>x.endsWith('.sql')).sort())await admin.query((await readFile(join(root,'supabase/migrations',file),'utf8')).replace(/create role housemed_\w+ nologin;/g,''));
 api=spawn(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(root,'src/api.ts')],{cwd:work,env:childEnv,stdio:['ignore','pipe','pipe']});children.push(api);let apiOut='',apiError='';api.stdout.on('data',x=>{apiOut+=x;});api.stderr.on('data',x=>{apiError+=x;});
 const readyBy=Date.now()+5000;while(true){try{assert.equal((await http('/v1/sources/status')).status,200);break;}catch(e){if(Date.now()>readyBy||api.exitCode!==null)throw Error('CONTROLLED_API_NOT_READY: '+apiError);await new Promise(r=>setTimeout(r,50));}}
 report.api_process={pid:api.pid,transport:'actual localhost HTTP',credentials:'separate local read-only role'};
 let main,other;
 await check('initial CLI collection persists two source listings and serves exact HTTP quotes',async()=>{
  const runs=[await collect('initial-hw',hw('MAIN')),await collect('initial-cp',cp())];runs.forEach(x=>collected(x));main=await state('healthwarehouse','MAIN');other=await state('costplus',cpKey);
  assert.equal(main.offers.length,5);assert.equal(other.offers.length,2);assert.equal(main.listing.medication_id,other.listing.medication_id);
  const body=await offers(main.listing.medication_id,'?quantity=30&unit=tablet&include_estimates=true');assert.deepEqual(body.items.map(x=>[x.source,x.price_cents]),[['healthwarehouse','900'],['costplus','555']]);return {runs,quotes:body.items,initial_history:main.history.length+other.history.length};
 });
 await check('price change appends once and unchanged CLI replay refreshes without duplicate history',async()=>{
  const before=await state('healthwarehouse','MAIN');const changed=await collect('price-change',hw('MAIN',{price30:'950'}));collected(changed);const middle=await state('healthwarehouse','MAIN');assert.equal(middle.history.length,before.history.length+1);
  const replay=await collect('unchanged-replay',hw('MAIN',{price30:'950'}));collected(replay);const after=await state('healthwarehouse','MAIN');assert.equal(after.history.length,middle.history.length);assert.ok(after.offers[0].last_checked_at>middle.offers[0].last_checked_at);assert.equal(after.offers.find(x=>x.quantity==='30').price_cents,'950');return {changed,replay,history_before:before.history.length,history_after:after.history.length};
 });
 await check('SQL failure rolls back an offer update before its history insert',async()=>{
  const before=await state('healthwarehouse','MAIN');const result=await collect('sql-rollback',hw('MAIN',{price30:'960',write_fault:'sql_error'}));collected(result,false);const after=await state('healthwarehouse','MAIN');assert.deepEqual(after.offers,before.offers);assert.deepEqual(after.history,before.history);return {result,unchanged_offers:after.offers.length,reason:result.runs.at(-1).checkpoint.collection_results};
 });
 await check('process kill during a write rolls back and the next CLI run recovers its abandoned record',async()=>{
  const before=await state('healthwarehouse','MAIN');const result=await collect('interrupted-write',hw('MAIN',{price30:'970',write_fault:'kill_before_history'}));assert.equal(result.signal,'SIGKILL');assert.equal(result.faultObserved,true);assert.equal(result.faultReadError,undefined);assert.equal(result.timedOut,false);assert.deepEqual(result.visibleDuringTransaction.offers,before.offers);assert.equal(result.httpDuringTransaction.items[0].price_cents,'950');
  assert.deepEqual((await state('healthwarehouse','MAIN')).offers,before.offers);const recovery=await collect('interrupt-recovery',hw('MAIN',{price30:'950'}));collected(recovery);
  assert.equal((await q('select status from pricing.crawl_runs where id=$1',[result.runs.at(-1).id]))[0].status,'interrupted');assert.deepEqual((await state('healthwarehouse','MAIN')).history,before.history);return {result,recovery};
 });
 await check('exhausted evidence uploads prevent publication of changed prices',async()=>{
  const before=await state('healthwarehouse','MAIN');const result=await collect('evidence-failure',hw('MAIN',{price30:'980',evidence_failure:true}));assert.equal(result.code,1);assert.equal(result.counts.storage_requests,6);const after=await state('healthwarehouse','MAIN');assert.deepEqual(after.offers,before.offers);assert.deepEqual(after.history,before.history);assert.ok((await offers(other.listing.medication_id,'?source=costplus&include_estimates=true')).items.length===2);return {result,upload_attempts_per_object:3,objects_attempted:2,publication_unchanged:true};
 });
 for(const status of [403,429])await check(`source HTTP ${status} pauses collection and preserves both sources' stored quotes`,async()=>{
  const before=await state('healthwarehouse','MAIN'),cpBefore=await state('costplus',cpKey);const result=await collect('source-'+status,hw('MAIN',{source_status:status,resume_blocked:status===429}));assert.equal(result.code,1);assert.equal(result.counts.source_requests,1);assert.equal(result.runs.at(-1).summary.source_paused,true);assert.deepEqual((await state('healthwarehouse','MAIN')).offers,before.offers);assert.deepEqual((await state('costplus',cpKey)).offers,cpBefore.offers);assert.equal((await offers(other.listing.medication_id,'?source=costplus&include_estimates=true')).items.length,2);return {result,price_and_observation_timestamps_preserved:true};
 });
 await check('canonical identity conflict is quarantined and excluded through HTTP',async()=>{
  const before=await state('healthwarehouse','MAIN');const result=await collect('identity-conflict',hw('MAIN',{medication:{...med,strength:'40 mg'},resume_blocked:true}));collected(result,false);const after=await state('healthwarehouse','MAIN');assert.equal(after.listing.match_status,'needs_review');assert.deepEqual(after.offers,before.offers);assert.deepEqual(after.history,before.history);const body=await offers(after.listing.medication_id,'?include_estimates=true');assert.equal(body.items.filter(x=>x.source==='healthwarehouse').length,0);assert.ok(body.exclusions.some(x=>x.reason==='not_verified'));return {result,exclusions:body.exclusions};
 });
 await check('complete missing tier retires the old quote and fails its fixed planned quantity check',async()=>{
  collected(await collect('tiers-initial',hw('TIERS',{medication:{...med,name:'e2e-tiers'}})));const result=await collect('tiers-missing',hw('TIERS',{medication:{...med,name:'e2e-tiers'},missing90:true}));collected(result,false);const after=await state('healthwarehouse','TIERS');assert.equal(after.offers.find(x=>x.quantity==='90').active,false);assert.equal(result.runs.at(-1).summary.successful_quantity_checks,4);const body=await offers(after.listing.medication_id,'?quantity=90&unit=tablet');assert.equal(body.items.length,0);return {result,exclusions:body.exclusions};
 });
 await check('partial API quantity collection preserves unrequested tiers; missing response publishes none',async()=>{
  const before=await state('costplus',cpKey),old90=before.offers.find(x=>x.quantity==='90');const subset=await collect('cp-partial',cp({planned_quantities:['30'],prices:{'30':'$5.65'}}));collected(subset);const middle=await state('costplus',cpKey);assert.deepEqual(middle.offers.find(x=>x.quantity==='90'),old90);
  const missing=await collect('cp-missing',cp({missing_quantity:'90',prices:{'30':'$5.75','90':'$6.66'}}));collected(missing,false);const after=await state('costplus',cpKey);assert.deepEqual(after.offers,middle.offers);assert.deepEqual(after.history,middle.history);return {subset,missing,unrequested_quantity_preserved:'90'};
 });
 for(const [kind,options] of Object.entries({stale:{clock_offset_ms:-25*3600000},expired:{},out_of_stock:{availability:'OutOfStock'},unknown:{availability:'PreOrder'}}))await check(`${kind} offers are excluded by the real HTTP API`,async()=>{
  const key=kind.toUpperCase(),result=await collect('eligibility-'+kind,hw(key,{...options,medication:{...med,name:'e2e-'+kind}}));collected(result,kind!=='unknown');const record=await state('healthwarehouse',key);
  if(kind==='expired')await q("update pricing.offers set valid_until=now()-interval '1 second' where listing_id=$1",[record.listing.id]);
  const body=await offers(record.listing.medication_id,'?include_estimates=true');assert.equal(body.items.length,0);const reason=['stale','expired'].includes(kind)?'stale_or_expired':kind;assert.ok(body.exclusions.some(x=>x.reason===reason));return {result,exclusions:body.exclusions,expiry_fixture_injected:kind==='expired'};
 });
 await check('pet-labeled 50-tablet pack converts two ordering units to exactly 100 tablets',async()=>{
  const scenario=hw('PETPACK',{medication:{name:'e2e-pimobendan',strength:'5 mg',form:'tablet',route:'oral',release_type:'immediate'}});const title='Pimobendan Test 5mg Tablets for Dogs, 50 Count';scenario.snapshot.title=title;scenario.snapshot.h1=[title];scenario.snapshot.product.name=title;
  scenario.snapshot.panel=`${title}\nSKU: PETPACK\nTotal price updated to $50.00\n1 Count • pack / $50.00\nSelected quantity: 1.`;
  scenario.snapshot.product.offers=[{price:50,priceCurrency:'USD',eligibleQuantity:{value:1},availability:'https://schema.org/InStock'},{price:90,priceCurrency:'USD',eligibleQuantity:{value:2},availability:'https://schema.org/InStock'}];scenario.snapshot.buttons=[{label:'Select quantity 1'},{label:'Select quantity 2'}];scenario.planned_quantities=['1','2'];
  const result=await collect('pet-pack',scenario);collected(result);const record=await state('healthwarehouse','PETPACK');assert.deepEqual(record.listing.metadata.species_labels,['dog']);assert.equal(record.listing.content_quantity,'50');const body=await offers(record.listing.medication_id,'?quantity=100&unit=tablet');assert.equal(body.items.length,1);assert.equal(body.items[0].ordering_quantity,'2');assert.equal(body.items[0].price_cents,'9000');assert.equal((await offers(record.listing.medication_id,'?quantity=60&unit=tablet')).items.length,0);return {result,quote:body.items[0],species_labels:record.listing.metadata.species_labels};
 });
 await check('HTTP authentication, absent mutation routes, and reader database write denial hold',async()=>{
  const unauth=await http('/v1/sources/status',{auth:false});assert.equal(unauth.status,401);const mutation=await http('/v1/medications',{method:'POST',body:{name:'bad'}});assert.equal(mutation.status,404);
  const reader=new pg.Pool({connectionString:dbUrl('housemed_reader'),max:1});let denied;try{await assert.rejects(reader.query("update pricing.sources set name='bad'"),e=>{denied=e.code;return e.code==='42501';});await assert.rejects(reader.query('select evidence_path from pricing.crawl_runs'),{code:'42501'});}finally{await reader.end();}
  const response=await http('/v1/sources/status');assert.ok(!JSON.stringify(response.body).includes('evidence_path'));return {unauthenticated_http:unauth.status,write_http:mutation.status,reader_write_sqlstate:denied};
 });
 report.status=cases.every(x=>x.status==='passed')?'passed':'failed';report.summary={passed:cases.filter(x=>x.status==='passed').length,failed:cases.filter(x=>x.status==='failed').length,counts:(await q('select (select count(*) from pricing.listings)::int listings,(select count(*) from pricing.offers)::int offers,(select count(*) from pricing.offer_history)::int history,(select count(*) from pricing.crawl_runs)::int runs'))[0]};
 await writeFile(join(work,'api.stdout.log'),apiOut);await writeFile(join(work,'api.stderr.log'),apiError);
}catch(e){report.status='failed';report.fatal_error={name:e.name,message:e.message,stack:e.stack};process.exitCode=1;}
finally{
 for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
 if(api&&api.exitCode===null)await new Promise(resolve=>{api.once('close',resolve);setTimeout(()=>{api.kill('SIGKILL');resolve();},3000).unref();});
 await admin?.end();await bootstrap?.end();
 if(createdDatabase){
  const cleanup=new pg.Pool({host:socket,port:65431,database:'postgres',max:1});
  try{assert.equal(resolve((await cleanup.query('show data_directory')).rows[0].data_directory),join(root,'.cache/pg-test'));await cleanup.query(`drop database if exists ${database} with(force)`);report.database_cleanup='removed_owned_test_database';}
  catch(e){report.status='failed';report.database_cleanup_error={name:e.name,message:e.message};}
  finally{await cleanup.end();}
 }
 await saveReport();
}
if(report.status!=='passed')process.exitCode=1;console.log(JSON.stringify({status:report.status,summary:report.summary,report:join(root,'data/reports/e2e-controlled.json')}));
