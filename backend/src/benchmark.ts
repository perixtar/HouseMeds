import {networkFetch} from './network.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';import {makePool} from './db.js';
import {validateManifest,manifestHash} from './pilot.js';
const smoke=process.argv.includes('--access-test');
const index=process.argv.indexOf('--manifest');
const manifest=smoke?null:validateManifest(JSON.parse(await readFile(index>=0?process.argv[index+1]:'data/manifests/acceptance.json','utf8')),false,true);
const pool=makePool(true);let samples:{medication_id:string;name:string;physical_quantity:string;unit:string}[]=[];let listingCounts:{source:string;listings:number}[]=[];
try{
 listingCounts=(await pool.query(`select s.slug as source,count(l.id)::int as listings from pricing.sources s left join pricing.listings l on l.source_id=s.id group by s.slug order by s.slug`)).rows;
 if(manifest){const verified=(await pool.query(`select count(*)::int n from pricing.listings l join pricing.sources s on s.id=l.source_id
  where l.match_status='verified' and exists(select 1 from jsonb_to_recordset($1::jsonb) as x(source text,source_product_key text) where x.source=s.slug and x.source_product_key=l.source_product_key)`,[JSON.stringify(manifest.listings)])).rows[0].n;if(verified!==200)throw Error('FULL_VERIFIED_PILOT_REQUIRED');}
 samples=(await pool.query(`select distinct on(l.id) l.medication_id,m.name,(o.quantity*l.content_quantity)::text as physical_quantity,l.content_unit as unit
  from pricing.offers o join pricing.listings l on l.id=o.listing_id join pricing.medications m on m.id=l.medication_id join pricing.sources s on s.id=l.source_id
  where s.enabled and l.match_status='verified' and o.active and o.availability='in_stock' and o.price_cents is not null and o.last_checked_at>=now()-interval '24 hours'
   and (o.valid_until is null or o.valid_until>now()) and ($1::jsonb is null or exists(select 1 from jsonb_to_recordset($1::jsonb) as x(source text,source_product_key text) where x.source=s.slug and x.source_product_key=l.source_product_key))
  order by l.id,o.id limit 300`,[manifest?JSON.stringify(manifest.listings):null])).rows;
}finally{await pool.end();}
if(!samples.length)throw Error('NO_FRESH_VERIFIED_BENCHMARK_SAMPLES');
const port=Number(process.env.PORT??63813);if(!Number.isInteger(port)||port<1||port>65535)throw Error('INVALID_API_PORT');
const base=`http://127.0.0.1:${port}`,token=process.env.HOUSEMED_API_TOKEN;if(!token)throw Error('API_TOKEN_REQUIRED');
function requestPath(i:number){const s=samples[i%samples.length];switch(i%4){case 0:return '/v1/sources/status';case 1:return '/v1/medications?q='+encodeURIComponent(s.name);case 2:return `/v1/medications/${s.medication_id}/offers`;default:return `/v1/medications/${s.medication_id}/offers?quantity=${encodeURIComponent(s.physical_quantity)}&unit=${encodeURIComponent(s.unit)}`;}}
const requestCount=1000,concurrency=10,warmup=40;let next=0;const results:{ms:number;status:number;valid:boolean}[]=[];
async function request(i:number){const start=performance.now();try{const res=await networkFetch(base+requestPath(i),{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});const body=await res.json() as {sources?:unknown[];items?:unknown[]};return {ms:performance.now()-start,status:res.status,valid:res.status===200&&(i%4===0?Array.isArray(body.sources):Array.isArray(body.items))};}catch{return {ms:performance.now()-start,status:0,valid:false};}}
for(let offset=0;offset<warmup;offset+=concurrency){const warm=await Promise.all(Array.from({length:Math.min(concurrency,warmup-offset)},(_,j)=>request(offset+j)));if(warm.some(x=>!x.valid))throw Error('BENCHMARK_WARMUP_FAILED');}
const started=new Date().toISOString(),deadline=performance.now()+180000;
await Promise.all(Array.from({length:concurrency},async()=>{while(next<requestCount&&performance.now()<deadline){const i=next++;results.push(await request(i));}}));
const times=results.map(x=>x.ms).sort((a,b)=>a-b);const p95=times[Math.ceil(times.length*.95)-1],errors=results.filter(x=>!x.valid).length;
const report={started_at:started,finished_at:new Date().toISOString(),scope:smoke?'preliminary_access_dataset':'audited_pilot',manifest_hash:manifest?manifestHash(manifest):null,
 node:process.version,platform:process.platform,arch:process.arch,api_origin:base,listing_counts:listingCounts,sample_offers:samples.length,
 requests:results.length,requested_reads:requestCount,concurrency,warmup_requests:warmup,request_mix:'equal lookup, all offers, exact quantity offers, and source status',timing_boundary:'local HTTP request through complete JSON body',
 p50_ms:times[Math.ceil(times.length*.5)-1],p95_ms:p95,max_ms:times.at(-1),unexpected_errors:errors,threshold_met:p95<=500&&errors===0&&results.length===requestCount,acceptance_performance_passed:!smoke&&p95<=500&&errors===0&&results.length===requestCount};
await mkdir('data/reports',{recursive:true});await writeFile('data/reports/benchmark-'+Date.now()+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(errors||p95>500||results.length!==requestCount)process.exitCode=1;
