import {writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {makePool} from '../src/db.js';
import {Repository} from '../src/repository.js';
import {EvidenceStore} from '../src/evidence.js';
import {networkFetch} from '../src/network.js';
import {normalizeUrl} from '../src/core.js';

const args=process.argv.slice(2);
const option=(name:string,fallback:string)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]??fallback;};
const delayMs=Number(option('--delay-ms',process.env.CRAWL_DELAY_MS??'1000'));
const maxQueries=Number(option('--max-queries','676'));
if(!Number.isFinite(delayMs)||delayMs<0)throw Error('INVALID_DELAY');
if(!Number.isInteger(maxQueries)||maxQueries<1||maxQueries>676)throw Error('INVALID_MAX_QUERIES');

type CostcoResult={drugId:string;drugName:string};
const letters='abcdefghijklmnopqrstuvwxyz';
const probes=letters.split('').flatMap(a=>letters.split('').map(b=>a+b)).slice(0,maxQueries);

function parseResults(html:string):CostcoResult[]{
 const match=html.match(/var rxSearchResults = (\{.*?\});/s);if(!match)return [];
 const data=JSON.parse(match[1]) as {drugResults?:CostcoResult[]};
 return (data.drugResults??[]).filter(x=>x.drugId&&x.drugName);
}
async function fetchProbe(query:string){
 const url='https://www.costco.com/pharmacy/drug-directory-search-results?insideDrugSearch=true&searchKeyword='+encodeURIComponent(query);
 const response=await networkFetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('HTTP_'+response.status);
 return {url,results:parseResults(await response.text())};
}

const pool=makePool(),repo=new Repository(pool),evidence=new EvidenceStore();
if(!process.env.SUPABASE_PROJECT_REF||/PROJECT|REF|YOUR|<|>|undefined/i.test(process.env.SUPABASE_PROJECT_REF)||/SECRET|KEY|YOUR|<|>|undefined/i.test(process.env.SUPABASE_SECRET_KEY??'')){
 delete process.env.SUPABASE_SECRET_KEY;
 delete process.env.SUPABASE_PROJECT_REF;
}
const source=await repo.source('costco');
let runId:string|undefined;
const found=new Map<string,{drugId:string;drugName:string;from:string}>();
const outcomes:Record<string,unknown>[]=[];

try{
 runId=(await pool.query("insert into pricing.crawl_runs(source_id,parser_version,checkpoint,summary) values($1,'0.1.0-costco-directory',$2,$3) returning id",[source.id,JSON.stringify({phase:'discover',source:'costco'}),JSON.stringify({phase:'discover',scope:'directory',access_channel:'website',probes:probes.length})])).rows[0].id;
 for(const probe of probes){
  try{
   await delay(delayMs);
   const {url,results}=await fetchProbe(probe);
   for(const item of results){
    const detail=`https://www.costco.com/drug-results-details-price?drugId=${encodeURIComponent(item.drugId)}&drugName=${encodeURIComponent(item.drugName)}&encodedDrugName=${encodeURIComponent(item.drugName)}`;
    const normalized=normalizeUrl(detail,detail,'costco');
    if(normalized&&!normalized.reason&&!found.has(normalized.url))found.set(normalized.url,{drugId:item.drugId,drugName:item.drugName,from:url});
   }
   outcomes.push({probe,status:'success',results:results.length,total:found.size});
   if(outcomes.length%25===0)console.log(JSON.stringify(outcomes.at(-1)));
  }catch(error){
   outcomes.push({probe,status:'failed',reason:error instanceof Error?error.message:'UNKNOWN_FAILURE'});
   console.error(JSON.stringify(outcomes.at(-1)));
  }
  await pool.query('update pricing.crawl_runs set checkpoint=$2,summary=$3 where id=$1',[runId,JSON.stringify({phase:'discover',processed:outcomes.length,total_found:found.size,outcomes}),JSON.stringify({phase:'discover',scope:'directory',access_channel:'website',processed:outcomes.length,total_found:found.size,failed:outcomes.filter(x=>x.status==='failed').length})]);
 }
 const items=[...found.entries()].map(([url,item])=>({url,from:item.from,reason:null}));
 for(let i=0;i<items.length;i+=1000)await repo.discover(source.id,items.slice(i,i+1000));
 await pool.query("update pricing.crawl_pages set page_type='product' where source_id=$1 and url=any($2::text[]) and page_type='unknown'",[source.id,items.map(x=>x.url)]);
 const ref=await evidence.put('costco',runId,'directory-summary',{outcomes,total_found:found.size,items:[...found.values()]});
 const summary={phase:'discover',scope:'directory',access_channel:'website',processed:outcomes.length,total_found:found.size,failed:outcomes.filter(x=>x.status==='failed').length};
 await pool.query("update pricing.crawl_runs set status=$2,finished_at=now(),checkpoint=$3,summary=$4,evidence_path=$5 where id=$1",[runId,summary.failed?'partial':'succeeded',JSON.stringify({phase:'discover',outcomes,total_found:found.size}),JSON.stringify(summary),ref]);
 await mkdir('data/reports',{recursive:true});await writeFile('data/reports/costco-directory-discovery.json',JSON.stringify({run_id:runId,summary,outcomes,total_found:found.size},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({event:'costco_directory_discovery_finished',run_id:runId,summary},null,2));
}catch(error){
 if(runId)await pool.query("update pricing.crawl_runs set status='failed',finished_at=now(),summary=$2 where id=$1",[runId,JSON.stringify({phase:'discover',reason:error instanceof Error?error.message:'UNKNOWN_FAILURE',processed:outcomes.length,total_found:found.size})]);
 throw error;
}finally{await pool.end();}
