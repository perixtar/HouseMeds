import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {load} from 'cheerio';
import {makePool} from '../src/db.js';
import {Repository} from '../src/repository.js';
import {EvidenceStore} from '../src/evidence.js';
import {networkFetch} from '../src/network.js';
import {costco,type Snapshot} from '../src/sources.js';
import {normalizeUrl,offerKey,type Listing,type Quote} from '../src/core.js';
import {loadTopMedicationCatalog,medicationKey} from '../src/top-medications.js';

const args=process.argv.slice(2);
const option=(name:string,fallback:string)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]??fallback;};
const limit=Number(option('--limit','25')),startIndex=Number(option('--start','0')),delayMs=Number(process.env.CRAWL_DELAY_MS??1500);
if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('INVALID_LIMIT');
if(!Number.isInteger(startIndex)||startIndex<0||startIndex>=200)throw Error('INVALID_START');

function entries(text:string){return text.split(/\n/).map(line=>line.match(/^\s*\d{3}\.\s+(.+?)\s*$/)?.[1]).filter((x):x is string=>Boolean(x));}
function clean(value:string){return medicationKey(value.replace(/,/g,';').replace(/\bHCTZ\b/ig,'Hydrochlorothiazide'));}
function parseResults(html:string){
 const match=html.match(/var rxSearchResults = (\{.*?\});/s);if(!match)return [];
 const data=JSON.parse(match[1]) as {drugResults?:{drugId:string;drugName:string}[]};
 return (data.drugResults??[]).filter(x=>x.drugId&&x.drugName);
}
function pickResult(search:string,results:{drugId:string;drugName:string}[]){
 const target=clean(search);
 return results.find(r=>clean(r.drugName)===target)??results.find(r=>clean(r.drugName).split(';').every(x=>target.includes(x))||target.split(';').every(x=>clean(r.drugName).includes(x)))??null;
}
function normalizeForm(value:string){
 const v=value.toLowerCase();
 if(['tab','tabs','tablet','tablets'].includes(v))return 'tablet';
 if(['cap','caps','capsule','capsules'].includes(v))return 'capsule';
 if(['sol','soln','solution'].includes(v))return 'solution';
 if(['cream','crm'].includes(v))return 'cream';
 if(['ointment','oint'].includes(v))return 'ointment';
 if(['susp','suspension'].includes(v))return 'suspension';
 return v.replace(/s$/,'');
}
function firstMedication(lines:string[]):Listing['medication']|null{
 for(let i=0;i<lines.length;i++){
  if(!/^(Generic Alternative|Brand Name):$/i.test(lines[i]))continue;
  const sourceName=lines[i+1]??'';
  const match=sourceName.replace(/\s+/g,' ').trim().match(/^(.+?)\s+(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s*(?:mg|mcg|g|gm|ml|%)(?:\/\d+(?:\.\d+)?\s*(?:mg|mcg|g|gm|ml))?)\s+([A-Za-z]+)(?:\s+.+)?$/i);
  if(match)return {name:match[1].trim().toLowerCase(),strength:match[2].replace(/\bgm\b/i,'g').replace(/([0-9])([a-z%])/ig,'$1 $2').replace(/\s+/g,' ').toLowerCase(),form:normalizeForm(match[3]),route:'oral',release_type:'immediate'};
 }
 return null;
}
async function fetchText(url:string){
 const response=await networkFetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('HTTP_'+response.status);
 return response.text();
}
async function saveLegacyObservation(sourceId:string,runId:string,parsed:{listing:Listing;offers:Quote[]},observed_at:string,evidence_path:string,pool:ReturnType<typeof makePool>){
 const db=await pool.connect();
 try{
  await db.query('begin');
  const l=parsed.listing,m=l.medication;
  let medId:string|null=null;
  if(m)medId=(await db.query(`insert into pricing.medications(name,strength,form,route,release_type) values($1,$2,$3,$4,$5)
   on conflict(name,strength,form,route,release_type) do update set name=excluded.name returning id`,[m.name,m.strength,m.form,m.route,m.release_type])).rows[0].id;
  const matched=medId!==null&&l.content_quantity!==null&&l.content_unit!==null;
  const listing=(await db.query(`insert into pricing.listings(source_id,source_product_key,medication_id,source_name,url,brand_name,sold_as,content_quantity,content_unit,match_status,metadata)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
   on conflict(source_id,source_product_key) do update set medication_id=excluded.medication_id,source_name=excluded.source_name,url=excluded.url,
    brand_name=excluded.brand_name,sold_as=excluded.sold_as,content_quantity=excluded.content_quantity,content_unit=excluded.content_unit,
    match_status=case when pricing.listings.match_status='needs_review' then 'needs_review' else excluded.match_status end,metadata=pricing.listings.metadata||excluded.metadata returning id`,
   [sourceId,l.source_product_key,medId,l.source_name,l.url,l.brand_name,l.sold_as,l.content_quantity,l.content_unit,matched?'verified':'unmatched',JSON.stringify(l.metadata)])).rows[0];
  const unique=[...new Map(parsed.offers.map(q=>[offerKey(q),q])).entries()];
  let changed=0;
  for(const [key,q] of unique){
   const prev=(await db.query('select * from pricing.offers where listing_id=$1 and offer_key=$2 for update',[listing.id,key])).rows[0];
   const modified=!prev||prev.price_cents!==q.price_cents||prev.availability!==q.availability||prev.active!==q.active||JSON.stringify(prev.terms)!==JSON.stringify(q.terms)||(prev.valid_until?.toISOString()??null)!==q.valid_until;
   const offer=(await db.query(`insert into pricing.offers(listing_id,offer_key,quantity,seller_key,location_key,program_key,price_cents,currency,availability,terms,active,last_checked_at,valid_until,crawl_run_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    on conflict(listing_id,offer_key) do update set price_cents=excluded.price_cents,availability=excluded.availability,terms=excluded.terms,active=excluded.active,
     last_checked_at=excluded.last_checked_at,valid_until=excluded.valid_until,crawl_run_id=excluded.crawl_run_id returning id`,
    [listing.id,key,q.quantity,q.seller_key,q.location_key,q.program_key,q.price_cents,q.currency,q.availability,JSON.stringify(q.terms),q.active,observed_at,q.valid_until,runId])).rows[0];
   if(modified){await db.query('insert into pricing.offer_history(offer_id,crawl_run_id,observed_at,price_cents,currency,availability,snapshot) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing',
    [offer.id,runId,observed_at,q.price_cents,q.currency,q.availability,JSON.stringify({quantity:q.quantity,seller_key:q.seller_key,location_key:q.location_key,program_key:q.program_key,terms:q.terms,active:q.active,valid_until:q.valid_until,package:{source_name:l.source_name,sold_as:l.sold_as,content_quantity:l.content_quantity,content_unit:l.content_unit,brand_name:l.brand_name},evidence_path})]);changed++;}
  }
  await db.query('update pricing.crawl_pages set listing_id=$3 where source_id=$1 and url=$2',[sourceId,l.url,listing.id]);
  await db.query('commit');
  return {listingId:listing.id as string,changed,offers:unique.length};
 }catch(error){await db.query('rollback');throw error;}finally{db.release();}
}

const pool=makePool(),repo=new Repository(pool),evidence=new EvidenceStore();
if(!process.env.SUPABASE_PROJECT_REF||/PROJECT|REF|YOUR|<|>|undefined/i.test(process.env.SUPABASE_PROJECT_REF)||/SECRET|KEY|YOUR|<|>|undefined/i.test(process.env.SUPABASE_SECRET_KEY??'')){
 delete process.env.SUPABASE_SECRET_KEY;
 delete process.env.SUPABASE_PROJECT_REF;
}
const source=await repo.source('costco'),top=await loadTopMedicationCatalog();
let runId:string|undefined;
const outcomes:Record<string,unknown>[]=[];
try{
 runId=(await pool.query("insert into pricing.crawl_runs(source_id,parser_version,checkpoint,summary) values($1,'0.1.0-costco-top200',$2,$3) returning id",[source.id,JSON.stringify({phase:'collect',source:'costco'}),JSON.stringify({phase:'collect',scope:'mvp',access_channel:'website',top_200_only:true})])).rows[0].id;
 const names=entries(await readFile('../top-200-us-prescription-medications.txt','utf8')).slice(startIndex,startIndex+limit);
 for(const name of names){
  try{
   await delay(delayMs);
   const searchUrl='https://www.costco.com/pharmacy/drug-directory-search-results?insideDrugSearch=true&searchKeyword='+encodeURIComponent(name);
   const result=pickResult(name,parseResults(await fetchText(searchUrl)));
   if(!result){outcomes.push({name,status:'not_found'});continue;}
   await delay(delayMs);
   const detailUrl=`https://www.costco.com/drug-results-details-price?drugId=${encodeURIComponent(result.drugId)}&drugName=${encodeURIComponent(result.drugName)}&encodedDrugName=${encodeURIComponent(result.drugName)}`;
   const normalized=normalizeUrl(detailUrl,detailUrl,'costco');if(!normalized||normalized.reason)throw Error('URL_EXCLUDED');
   await repo.discover(source.id,[{url:normalized.url,from:searchUrl,reason:null}]);
   const html=await fetchText(normalized.url),$=load(html),panel=$('main').text(),lines=panel.replace(/\u00a0/g,' ').split(/\n+/).map(x=>x.trim()).filter(Boolean);
   const medication=firstMedication(lines);if(!medication)throw Error('COSTCO_NO_PARSEABLE_MEDICATION_ROW');
   const snapshot:Snapshot={url:normalized.url,title:$('title').text(),h1:$('h1').toArray().map(x=>$(x).text().trim()),links:$('a[href]').toArray().map(x=>new URL($(x).attr('href')!,normalized.url).href),product:null,panel,buttons:[],range:null,next:false,status:200};
   const parsed=costco(snapshot,{medication});
   if(!top.includes(parsed.listing)){outcomes.push({name,status:'skipped',reason:'MEDICATION_OUT_OF_SCOPE',detail:result.drugName});continue;}
   const observed_at=new Date().toISOString(),ref=await evidence.put('costco',runId,normalized.url,{snapshot:{...snapshot,panel:snapshot.panel.slice(0,12000)},parsed,observed_at});
   const saved=await saveLegacyObservation(source.id,runId,parsed,observed_at,ref,pool);
   await pool.query("update pricing.crawl_pages set page_type='product',last_attempt_at=now(),last_success_at=now(),last_result='success',next_crawl_at=now()+interval '1 day' where source_id=$1 and url=$2",[source.id,normalized.url]);
   outcomes.push({name,status:'collected',detail:result.drugName,listing_id:saved.listingId,changed:saved.changed,offers:saved.offers});
   console.log(JSON.stringify(outcomes.at(-1)));
  }catch(error){
   const reason=error instanceof Error?error.message:'UNKNOWN_FAILURE';
   outcomes.push({name,status:'failed',reason});
   console.error(JSON.stringify(outcomes.at(-1)));
  }
  await pool.query('update pricing.crawl_runs set checkpoint=$2,summary=$3 where id=$1',[runId,JSON.stringify({phase:'collect',processed:outcomes.length,outcomes}),JSON.stringify({phase:'collect',scope:'mvp',access_channel:'website',top_200_only:true,processed:outcomes.length,collected:outcomes.filter(x=>x.status==='collected').length,failed:outcomes.filter(x=>x.status==='failed').length,not_found:outcomes.filter(x=>x.status==='not_found').length})]);
 }
 const summary={phase:'collect',scope:'mvp',access_channel:'website',top_200_only:true,processed:outcomes.length,collected:outcomes.filter(x=>x.status==='collected').length,failed:outcomes.filter(x=>x.status==='failed').length,not_found:outcomes.filter(x=>x.status==='not_found').length,skipped:outcomes.filter(x=>x.status==='skipped').length};
 const ref=await evidence.put('costco',runId,'run-summary',{summary,outcomes});
 await pool.query("update pricing.crawl_runs set status=$2,finished_at=now(),checkpoint=$3,summary=$4,evidence_path=$5 where id=$1",[runId,summary.failed?'partial':'succeeded',JSON.stringify({phase:'collect',outcomes}),JSON.stringify(summary),ref]);
 await mkdir('data/reports',{recursive:true});await writeFile('data/reports/costco-top-collect.json',JSON.stringify({run_id:runId,summary,outcomes},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({event:'costco_collect_finished',run_id:runId,summary},null,2));
}catch(error){
 if(runId)await pool.query("update pricing.crawl_runs set status='failed',finished_at=now(),summary=$2 where id=$1",[runId,JSON.stringify({phase:'collect',reason:error instanceof Error?error.message:'UNKNOWN_FAILURE',outcomes})]);
 throw error;
}finally{await pool.end();}
