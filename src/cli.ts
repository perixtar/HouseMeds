import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {makePool} from './db.js';import {Repository} from './repository.js';import {EvidenceStore} from './evidence.js';
import {SourceClient,SourceAccessError,healthwarehouse,costplus,type Snapshot} from './sources.js';
import {sources,CP_API,normalizeUrl,hash,stable,type SourceSlug,type Json,type Listing} from './core.js';
const [command,slug,...args]=process.argv.slice(2);
if(!['discover','collect','status'].includes(command)||!['healthwarehouse','costplus'].includes(slug))throw Error('Usage: npm run crawl -- discover|collect|status healthwarehouse|costplus [--max-pages N] [--minutes N] [--manifest path]');
const source=slug as SourceSlug;
function option(name:string,fallback:string){const i=args.indexOf(name);return i<0?fallback:args[i+1]??fallback;}
const maxPages=Number(option('--max-pages','100')),minutes=Number(option('--minutes','20'));
if(!Number.isFinite(maxPages)||maxPages<1||maxPages>10000||!Number.isFinite(minutes)||minutes<1||minutes>120)throw Error('INVALID_RUN_BUDGET');
const pool=makePool(),repo=new Repository(pool),evidence=new EvidenceStore(),client=new SourceClient(source);
const sourceRow=await repo.source(source);
if(command==='status'){
 console.log(JSON.stringify((await pool.query('select page_type,last_result,count(*)::int as count from pricing.crawl_pages where source_id=$1 group by page_type,last_result order by page_type,last_result',[sourceRow.id])).rows,null,2));await pool.end();process.exit(0);
}
const lock=await pool.connect();const locked=(await lock.query('select pg_try_advisory_lock($1::bigint) as locked',[sourceRow.id])).rows[0].locked;
if(!locked){lock.release();await pool.end();throw Error('SOURCE_ALREADY_RUNNING');}
let runId:string|undefined,checkpoint:Json={},processed=0,replayed=0,failures=0,stopping=false;
const start=Date.now(),deadline=start+minutes*60000;
process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
let catalog:Json[]=[];let cohortSize=0;
async function remember(snapshot:Snapshot,pageId:string,state:number){
 const discovered=snapshot.links.map(h=>normalizeUrl(h,snapshot.url,source)).filter((x):x is {url:string;reason:string|null}=>Boolean(x)).map(x=>({...x,from:snapshot.url}));
 await repo.discover(sourceRow.id,discovered);
 const kind=snapshot.product?'product':snapshot.next||snapshot.range||snapshot.url.endsWith('/sitemap')||(source==='costplus'&&/\/medications\/(?:categories\/.*)?$/.test(new URL(snapshot.url).pathname))||snapshot.url===sources[source].origin+'/'?'directory':/privacy|terms|shipping|policy|hipaa/.test(snapshot.url)?'policy':'content';
 const ref=await evidence.put(source,runId!,`${pageId}:${state}`,{page_id:pageId,state,observed_at:new Date().toISOString(),url:snapshot.url,title:snapshot.title,h1:snapshot.h1,links:discovered,range:snapshot.range,has_next:snapshot.next,product:snapshot.product,buttons:snapshot.product?snapshot.buttons.filter(x=>/^Select (?:quantity|Quantity|Strength|Form)/.test(x.label)):[]});
 checkpoint={...checkpoint,phase:command,current_page_id:pageId,current_url:snapshot.url,state_index:state,fingerprint:hash(stable([snapshot.range,snapshot.links])),last_evidence:ref};
 await pool.query('update pricing.crawl_runs set checkpoint=$2,evidence_path=$3 where id=$1',[runId,JSON.stringify(checkpoint),ref]);
 return kind;
}
async function begin(){
 await client.init();
 const latest=(await pool.query('select * from pricing.crawl_runs where source_id=$1 order by started_at desc,id desc limit 1',[sourceRow.id])).rows[0];
 if(latest?.summary?.source_paused&&!args.includes('--resume-blocked'))throw Error('SOURCE_PAUSED_REQUIRES_REVIEW');
 if(latest?.status==='running'){await pool.query("update pricing.crawl_runs set status='interrupted',finished_at=now() where id=$1",[latest.id]);}
 const phaseLast=(await pool.query("select * from pricing.crawl_runs where source_id=$1 and checkpoint->>'phase'=$2 order by started_at desc,id desc limit 1",[sourceRow.id,command])).rows[0];
 const previous=!args.includes('--fresh')&&phaseLast&&['partial','interrupted'].includes(phaseLast.status)?phaseLast:null;
 checkpoint=previous?.checkpoint??{phase:command};
 runId=(await pool.query("insert into pricing.crawl_runs(source_id,parser_version,checkpoint,summary) values($1,'0.1.0',$2,$3) returning id",[sourceRow.id,JSON.stringify(checkpoint),JSON.stringify({phase:command})])).rows[0].id;
 if(source==='costplus'){
  const result=await client.json(CP_API);if(!Array.isArray(result.results)||!result.results.length)throw Error('EMPTY_OR_INVALID_CATALOG');catalog=result.results as Json[];
  await evidence.put(source,runId!,'catalog',{observed_at:new Date().toISOString(),results:catalog});
  const urls=catalog.map(x=>normalizeUrl(String(x.url),sources[source].origin,source)).filter((x):x is {url:string;reason:string|null}=>Boolean(x));
  await repo.discover(sourceRow.id,urls.map(x=>({...x,from:null})));
  await pool.query("update pricing.crawl_pages set page_type='product' where source_id=$1 and url=any($2::text[]) and page_type='unknown'",[sourceRow.id,urls.map(x=>x.url)]);
 }
 await repo.discover(sourceRow.id,sources[source].seeds.map(path=>({url:new URL(path,sources[source].origin).href,from:null,reason:null})));
}
async function discover(){
 while(!stopping&&Date.now()<deadline&&processed+replayed<maxPages){
  let row=checkpoint.current_page_id?(await pool.query('select * from pricing.crawl_pages where id=$1 and source_id=$2',[checkpoint.current_page_id,sourceRow.id])).rows[0]:null;
  if(!row)row=(await pool.query(`select * from pricing.crawl_pages where source_id=$1 and page_type<>'ignored' and last_success_at is null and last_result is distinct from 'not_found' and next_crawl_at<=now()
   order by case when url=$2 or url=$2||'sitemap' or url=$2||'medications/' then 0 when page_type='product' then 3 else 1 end,
   first_seen_at,id limit 1`,[sourceRow.id,sources[source].origin+'/'])).rows[0];
  if(!row)break;
  if(!client.allowed(row.url)){await pool.query("update pricing.crawl_pages set page_type='ignored',last_result=null,next_crawl_at=null where id=$1",[row.id]);checkpoint={phase:command};continue;}
  try{
   let snap=await client.open(row.url,row.discovered_from??undefined),state=0;
   const resume=checkpoint.current_page_id===row.id?Number(checkpoint.state_index??-1):-1;
   while(state<=resume&&snap.next){
    if(stopping||Date.now()>=deadline||processed+replayed>=maxPages)return;
    // A category may change during a pause. Preserve newly seen links while replaying.
    await remember(snap,row.id,state);replayed++;snap=await client.next(snap);state++;
   }
   let kind='content';const seen=new Set<string>();let categoryComplete=false;
   while(!stopping&&Date.now()<deadline&&processed+replayed<maxPages){
    const fingerprint=hash(stable([snap.range,snap.links]));if(seen.has(fingerprint))throw new SourceAccessError('PAGINATION_LOOP');seen.add(fingerprint);
    kind=await remember(snap,row.id,state);processed++;
    console.log(JSON.stringify({event:'discovered',source,run_id:runId,page_id:row.id,url:row.url,kind,state,links:snap.links.length,processed}));
    if(!snap.next){categoryComplete=true;break;}
    if(Date.now()>=deadline||processed+replayed>=maxPages||stopping)break;
    snap=await client.next(snap);state++;
   }
   if(categoryComplete){await repo.pageResult(row.id,kind,'success',true);checkpoint={phase:command};await pool.query('update pricing.crawl_runs set checkpoint=$2 where id=$1',[runId,JSON.stringify(checkpoint)]);}
   else break;
  }catch(e){failures++;const code=e instanceof Error?e.message:'UNKNOWN_FAILURE';const blocked=/SOURCE_BLOCKED|SOURCE_CHALLENGE|SOURCE_RATE_LIMITED/.test(code);await repo.pageResult(row.id,row.page_type,blocked?'blocked':code==='HTTP_404'?'not_found':'failed',false);await evidence.put(source,runId!,row.url+':failure',{url:row.url,code,observed_at:new Date().toISOString()});checkpoint={phase:command};await pool.query('update pricing.crawl_runs set checkpoint=$2 where id=$1',[runId,JSON.stringify(checkpoint)]);console.log(JSON.stringify({event:'page_failed',source,url:row.url,code}));if(blocked)throw e;}
 }
}
async function collect(){
 const file=option('--manifest','data/manifests/acceptance.json');
 const manifest=JSON.parse(await readFile(file,'utf8')) as {inventory_audit_passed:boolean;listings:{source:SourceSlug;page_id:string;url:string;review?:Partial<Listing>}[]};
 const pilot=manifest.listings.filter(x=>x.source===source);cohortSize=pilot.length;
 if(!manifest.inventory_audit_passed&&!args.includes('--access-test'))throw Error('INVENTORY_AUDIT_REQUIRED');
 if(!args.includes('--access-test')&&pilot.length!==100)throw Error('EXPECTED_100_SOURCE_LISTINGS');
 const fileHash=hash(stable(manifest));if(checkpoint.manifest_hash&&checkpoint.manifest_hash!==fileHash)throw Error('MANIFEST_CHANGED_DURING_RESUME');
 const beginIndex=Number(checkpoint.manifest_index??0);
 for(let i=beginIndex;i<pilot.length&&!stopping&&Date.now()<deadline&&processed+replayed<maxPages;i++){
  const selected=pilot[i];
  const page=(await pool.query("select * from pricing.crawl_pages where id=$1 and source_id=$2 and page_type<>'ignored'",[selected.page_id,sourceRow.id])).rows[0];
  if(!page||page.url!==selected.url)throw Error('MANIFEST_INVENTORY_MISMATCH');
  try{const snap=await client.open(page.url,page.discovered_from??undefined);let parsed:{listing:Listing;offers:import('./core.js').Quote[]};
   if(source==='healthwarehouse')parsed=healthwarehouse(snap,selected.review);
   else {const candidates=catalog.filter(x=>normalizeUrl(String(x.url),sources[source].origin,source)?.url===page.url);if(candidates.length!==1)throw Error('AMBIGUOUS_CATALOG_PRODUCT');parsed=await costplus(client,snap,candidates[0],selected.review);}
   const observed_at=new Date().toISOString();const ref=await evidence.put(source,runId!,page.url,{snapshot:snap,parsed,observed_at});
   const result=await repo.saveObservation(sourceRow.id,runId!,{...parsed,observed_at,evidence_path:ref,complete:true});
   if(result.ignored)throw Error(result.ignored);
   await repo.pageResult(page.id,'product','success',true);console.log(JSON.stringify({event:'collected',source,url:page.url,offers:parsed.offers.length,...result}));
  }catch(e){failures++;const code=e instanceof Error?e.message:'UNKNOWN_FAILURE';await repo.pageResult(page.id,'product',/SOURCE_BLOCKED|SOURCE_CHALLENGE|SOURCE_RATE_LIMITED/.test(code)?'blocked':code==='HTTP_404'?'not_found':'failed',false);await evidence.put(source,runId!,page.url+':failure',{url:page.url,code,observed_at:new Date().toISOString()});console.log(JSON.stringify({event:'collection_failed',source,url:page.url,code}));if(/SOURCE_BLOCKED|SOURCE_CHALLENGE|SOURCE_RATE_LIMITED/.test(code))throw e;}
  processed++;checkpoint={phase:command,manifest_hash:fileHash,manifest_index:i+1};await pool.query('update pricing.crawl_runs set checkpoint=$2 where id=$1',[runId,JSON.stringify(checkpoint)]);
 }
}
try{
 await begin();if(command==='discover')await discover();else await collect();
 const remaining=command==='discover'?(await pool.query("select count(*)::int n from pricing.crawl_pages where source_id=$1 and page_type<>'ignored' and last_success_at is null and last_result is distinct from 'not_found'",[sourceRow.id])).rows[0].n:Math.max(0,cohortSize-Number(checkpoint.manifest_index??0));
 const incomplete=command==='discover'?remaining>0:Number(checkpoint.manifest_index??0)<cohortSize;
 const status=stopping?'interrupted':failures||incomplete||Date.now()>deadline?'partial':'succeeded';
 const summary={phase:command,scope:args.includes('--access-test')?'access_test':'mvp',planned_listings:command==='collect'?cohortSize:null,processed,replayed,failures,remaining,elapsed_ms:Date.now()-start};
 const ref=await evidence.put(source,runId!,'run-summary',{...summary,status,checkpoint});
 await pool.query('update pricing.crawl_runs set status=$2,finished_at=now(),summary=$3,evidence_path=$4 where id=$1',[runId,status,JSON.stringify(summary),ref]);
 console.log(JSON.stringify({event:'run_finished',source,run_id:runId,status,...summary}));
}catch(e){const code=e instanceof Error?e.message:'UNKNOWN_FAILURE';console.error(JSON.stringify({event:'run_failed',source,run_id:runId,code}));if(runId)await pool.query("update pricing.crawl_runs set status='failed',finished_at=now(),summary=$2 where id=$1",[runId,JSON.stringify({phase:command,scope:args.includes('--access-test')?'access_test':'mvp',processed,replayed,failures,reason:code,retry_after_seconds:e instanceof SourceAccessError?e.retryAfter:null,source_paused:/SOURCE_BLOCKED|SOURCE_CHALLENGE|SOURCE_RATE_LIMITED/.test(code)})]);process.exitCode=1;}
finally{await client.close();await lock.query('select pg_advisory_unlock($1::bigint)',[sourceRow.id]);lock.release();await pool.end();}
