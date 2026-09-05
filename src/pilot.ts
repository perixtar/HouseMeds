import {hash,stable,quantity,normalizeUrl,sources,type SourceSlug,type Listing,type Quote} from './core.js';
export interface PilotListing {
 source:SourceSlug;page_id:string;url:string;source_product_key?:string;
 planned_quantities?:string[];review?:Partial<Listing>;
}
export interface PilotManifest {
 inventory_audit_passed:boolean;listing_audit_passed?:boolean;
 listings:PilotListing[];
}
export interface CollectionResult {
 successful:boolean;attempted_at:string;successful_quantities:string[];reason?:string;
}
export const DAY_MS=86400000,WINDOW_MS=7200000;
export function validateManifest(value:unknown,accessTest=false,scheduled=false):PilotManifest {
 if(!value||typeof value!=='object')throw Error('INVALID_MANIFEST');
 const m=value as PilotManifest;if(!Array.isArray(m.listings)||m.listings.length===0)throw Error('EMPTY_MANIFEST');
 if(!accessTest&&m.inventory_audit_passed!==true)throw Error('INVENTORY_AUDIT_REQUIRED');
 if(scheduled&&m.listing_audit_passed!==true)throw Error('LISTING_AUDIT_REQUIRED');
 const seenPages=new Set<string>(),seenUrls=new Set<string>(),seenProducts=new Set<string>();
 for(const item of m.listings){
  if(!Object.hasOwn(sources,item.source)||!/^[1-9][0-9]{0,17}$/.test(item.page_id))throw Error('INVALID_MANIFEST_IDENTITY');
  const normalized=normalizeUrl(item.url,sources[item.source].origin,item.source);
  if(!normalized||normalized.reason||normalized.url!==item.url)throw Error('INVALID_MANIFEST_URL');
  const key=item.source+':'+item.page_id,url=item.source+':'+item.url;
  if(seenPages.has(key)||seenUrls.has(url))throw Error('DUPLICATE_MANIFEST_LISTING');seenPages.add(key);seenUrls.add(url);
  if(item.source_product_key){const product=item.source+':'+item.source_product_key;if(seenProducts.has(product))throw Error('DUPLICATE_MANIFEST_PRODUCT');seenProducts.add(product);}
  if(item.planned_quantities){const qs=item.planned_quantities.map(quantity);if(!qs.length||new Set(qs).size!==qs.length)throw Error('INVALID_PLANNED_QUANTITIES');if(qs.some((q,i)=>q!==item.planned_quantities![i]))throw Error('NONCANONICAL_PLANNED_QUANTITY');}
  if(scheduled&&(!item.source_product_key||!item.planned_quantities?.length))throw Error('FROZEN_PRODUCT_AND_QUANTITIES_REQUIRED');
 }
 if(!accessTest)for(const source of ['healthwarehouse','costplus'])if(m.listings.filter(x=>x.source===source).length!==100)throw Error('EXPECTED_100_SOURCE_LISTINGS');
 return m;
}
export function manifestHash(manifest:PilotManifest){return hash(stable(manifest));}
export function resultForOffers(planned:PilotListing,offers:Quote[],now=new Date()):CollectionResult {
 const available=new Set(offers.filter(x=>x.active&&(x.availability==='out_of_stock'||(x.availability==='in_stock'&&x.price_cents!==null))).map(x=>x.quantity));
 const expected=planned.planned_quantities??offers.map(x=>x.quantity);
 const successful_quantities=expected.filter(q=>available.has(q));
 return {successful:successful_quantities.length===expected.length,attempted_at:now.toISOString(),successful_quantities,...(successful_quantities.length!==expected.length?{reason:'PLANNED_QUANTITIES_MISSING_OR_UNKNOWN'}:{})};
}
export function collectionMetrics(items:PilotListing[],results:Record<string,CollectionResult>){
 const plannedQuantities=items.every(x=>x.planned_quantities?.length)?items.reduce((n,x)=>n+x.planned_quantities!.length,0):null;
 let attempted=0,successful=0,successfulQuantities=0;
 for(const item of items){const r=results[item.page_id];if(!r)continue;attempted++;if(r.successful)successful++;
  if(item.planned_quantities)successfulQuantities+=new Set(r.successful_quantities.filter(q=>item.planned_quantities!.includes(q))).size;
 }
 return {planned_listings:items.length,attempted_listings:attempted,successful_listings:successful,failed_listings:attempted-successful,unattempted_listings:items.length-attempted,
  planned_quantity_checks:plannedQuantities,successful_quantity_checks:plannedQuantities===null?null:successfulQuantities,
  listing_success_rate:items.length?successful/items.length:0,quantity_success_rate:plannedQuantities?successfulQuantities/plannedQuantities:null};
}
export function dailyWindow(first:string,now:Date){
 const anchor=Date.parse(first);if(!Number.isFinite(anchor))throw Error('INVALID_FIRST_WINDOW');
 const index=Math.floor((now.getTime()-anchor)/DAY_MS);if(index<0)return null;
 const start=anchor+index*DAY_MS;return {index,start:new Date(start).toISOString(),deadline:new Date(start+WINDOW_MS).toISOString(),open:now.getTime()<start+WINDOW_MS};
}
export interface ReliabilityRun {id:string;source:SourceSlug;status:string;started_at:string|Date;finished_at:string|Date|null;summary:Record<string,any>;checkpoint?:Record<string,any>;}
export function reliabilityReport(manifest:PilotManifest,firstWindow:string,runs:ReliabilityRun[],now=new Date()){
 const expectedHash=manifestHash(manifest),anchor=Date.parse(firstWindow);if(!Number.isFinite(anchor))throw Error('INVALID_FIRST_WINDOW');
 const windows=[];let consecutive=0,best=0;
 const last=Math.floor((now.getTime()-anchor)/DAY_MS);
 for(let index=0;index<=last;index++){
  const start=new Date(anchor+index*DAY_MS).toISOString(),deadline=anchor+index*DAY_MS+WINDOW_MS;
  const bySource=(['healthwarehouse','costplus'] as const).map(source=>{
   const candidates=runs.filter(r=>r.source===source&&r.summary.scope==='scheduled'&&r.summary.window_start===start&&r.summary.manifest_hash===expectedHash);
   const valid=candidates.filter(r=>r.finished_at&&new Date(r.started_at).getTime()>=Date.parse(start)&&new Date(r.finished_at).getTime()<=deadline&&['succeeded','partial'].includes(r.status));
   // A resumed checkpoint contains outcomes from that same window. Never add runs together.
   const latest=valid.sort((a,b)=>new Date(b.finished_at!).getTime()-new Date(a.finished_at!).getTime())[0];
   const metrics=collectionMetrics(manifest.listings.filter(x=>x.source===source),latest?.checkpoint?.collection_results??{});
   const lateOrRunning=candidates.some(r=>r.status==='running'||(r.finished_at&&new Date(r.finished_at).getTime()>deadline));
   const anyIntervention=candidates.some(r=>r.summary.operator_intervention===true);
   const met=Boolean(latest)&&!lateOrRunning&&!anyIntervention&&metrics.listing_success_rate>=0.95&&(metrics.quantity_success_rate??0)>=0.95;
   return {source,run_id:latest?.id??null,...metrics,passed:met,reason:met?null:anyIntervention?'operator_intervention':lateOrRunning?'unfinished_or_late':!candidates.length?'missing_run':!latest?'unfinished_failed_or_late':'below_success_threshold'};
  });
  const closed=now.getTime()>=deadline,passed=closed&&bySource.every(x=>x.passed);
  if(closed){consecutive=passed?consecutive+1:0;best=Math.max(best,consecutive);}
  windows.push({index,window_start:start,deadline:new Date(deadline).toISOString(),status:closed?(passed?'passed':'failed'):'in_progress',sources:bySource});
 }
 return {as_of:now.toISOString(),manifest_hash:expectedHash,first_window_at:firstWindow,consecutive_passing_windows:consecutive,best_passing_streak:best,
  seven_day_collection_passed:best>=7,windows,scope:'Collection reliability only; other MVP acceptance gates remain separate.'};
}
