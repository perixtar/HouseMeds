import type pg from 'pg';
import { transaction } from './db.js';
import { assertObservation, offerKey, stable, type SourceSlug, type Observation, type Quote, type Json, type Listing } from './core.js';
function context(q:Quote,l:Listing):Json{return {quantity:q.quantity,seller_key:q.seller_key,location_key:q.location_key,program_key:q.program_key,terms:q.terms,active:q.active,valid_until:q.valid_until,package:{source_name:l.source_name,sold_as:l.sold_as,content_quantity:l.content_quantity,content_unit:l.content_unit,brand_name:l.brand_name}};}
export class Repository {
 constructor(public pool:pg.Pool){}
 async source(slug:SourceSlug){const {rows}=await this.pool.query('select * from pricing.sources where slug=$1 and enabled',[slug]);if(!rows[0])throw Error('SOURCE_DISABLED_OR_UNKNOWN');return rows[0] as {id:string,slug:SourceSlug,base_url:string};}
 async discover(sourceId:string,items:{url:string;from:string|null;reason:string|null}[]){
  if(!items.length)return;
  await this.pool.query(`insert into pricing.crawl_pages(source_id,url,discovered_from,page_type,next_crawl_at)
   select $1,x.url,x.parent,case when x.reason is null then 'unknown' else 'ignored' end,case when x.reason is null then now() end
   from jsonb_to_recordset($2::jsonb) as x(url text,parent text,reason text)
   on conflict(source_id,url) do update set last_seen_at=greatest(pricing.crawl_pages.last_seen_at,excluded.last_seen_at)`,[sourceId,JSON.stringify([...new Map(items.map(i=>[i.url,{url:i.url,parent:i.from,reason:i.reason}])).values()])]);
 }
 async nextDiscovery(sourceId:string,origin:string,cutoff:string|null){
  const {rows}=await this.pool.query(`select * from pricing.crawl_pages where source_id=$1 and page_type<>'ignored' and next_crawl_at<=now()
   and ((last_success_at is null and last_result is distinct from 'not_found') or ($3::timestamptz is not null and next_crawl_at<=$3))
   order by case when url=$2 or url=$2||'sitemap' or url=$2||'medications/' then 0 when page_type='product' then 3 else 1 end,first_seen_at,id limit 1`,[sourceId,origin+'/',cutoff]);return rows[0]??null;
 }
 async remainingDiscovery(sourceId:string,cutoff:string|null){
  return (await this.pool.query(`select count(*)::int n from pricing.crawl_pages where source_id=$1 and page_type<>'ignored'
   and ((last_success_at is null and last_result is distinct from 'not_found') or ($2::timestamptz is not null and next_crawl_at<=$2))`,[sourceId,cutoff])).rows[0].n as number;
 }
 async pageResult(pageId:string,kind:string,result:string,success:boolean){await this.pool.query(`update pricing.crawl_pages set page_type=$2,last_attempt_at=statement_timestamp(),last_result=$3,
 last_success_at=case when $4 then statement_timestamp() else last_success_at end,
 next_crawl_at=statement_timestamp()+(case when $4 and $2='product' then interval '1 day' when $4 then interval '7 days' else interval '1 hour' end) where id=$1`,[pageId,kind,result,success]);}
 async saveObservation(sourceId:string,runId:string,o:Observation){
  assertObservation(o);
  return transaction(this.pool,async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[sourceId+':'+o.listing.source_product_key]);
   const run=await db.query('select source_id from pricing.crawl_runs where id=$1 and status=\'running\'',[runId]);
   if(run.rows[0]?.source_id!==sourceId)throw Error('INVALID_OBSERVATION_RUN');
   const old=(await db.query('select * from pricing.listings where source_id=$1 and source_product_key=$2 for update',[sourceId,o.listing.source_product_key])).rows[0];
   if(old){
    const latest=(await db.query('select max(last_checked_at) as time from pricing.offers where listing_id=$1',[old.id])).rows[0].time;
    if(latest&&new Date(latest)>new Date(o.observed_at))return {listingId:old.id,changed:0,ignored:'older_observation'};
    const fields=['source_name','sold_as','content_quantity','content_unit','brand_name'] as const;
    const conflict=fields.some(k=>old[k]!==null&&o.listing[k]!==null&&String(old[k])!==String(o.listing[k]));
    if(conflict){await db.query("update pricing.listings set match_status='needs_review',metadata=metadata||$2::jsonb where id=$1",[old.id,JSON.stringify({identity_conflict_evidence:o.evidence_path})]);return {listingId:old.id,changed:0,ignored:'identity_conflict'};}
   }
   let medId=old?.medication_id??null;
   if(o.listing.medication){const m=o.listing.medication;medId=(await db.query(`insert into pricing.medications(name,strength,form,route,release_type) values($1,$2,$3,$4,$5)
   on conflict(name,strength,form,route,release_type) do update set name=excluded.name returning id`,[m.name,m.strength,m.form,m.route,m.release_type])).rows[0].id;}
   const l=o.listing,matched=medId!==null&&l.content_quantity!==null&&l.content_unit!==null;
   const listing=(await db.query(`insert into pricing.listings(source_id,source_product_key,medication_id,source_name,url,brand_name,sold_as,content_quantity,content_unit,match_status,metadata)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict(source_id,source_product_key) do update set medication_id=excluded.medication_id,source_name=excluded.source_name,url=excluded.url,
     brand_name=excluded.brand_name,sold_as=excluded.sold_as,content_quantity=excluded.content_quantity,content_unit=excluded.content_unit,
     match_status=case when pricing.listings.match_status='needs_review' then 'needs_review' else excluded.match_status end,metadata=pricing.listings.metadata||excluded.metadata returning id`,
    [sourceId,l.source_product_key,medId,l.source_name,l.url,l.brand_name,l.sold_as,l.content_quantity,l.content_unit,matched?'verified':'unmatched',JSON.stringify(l.metadata)])).rows[0];
   const current=(await db.query('select * from pricing.offers where listing_id=$1 for update',[listing.id])).rows;
   const incoming=new Map(o.offers.map(q=>[offerKey(q),q]));let changed=0;
   if(o.complete)for(const prev of current)if(prev.active&&!incoming.has(prev.offer_key))incoming.set(prev.offer_key,{quantity:prev.quantity,price_cents:prev.price_cents,currency:prev.currency,availability:prev.availability,seller_key:prev.seller_key,location_key:prev.location_key,program_key:prev.program_key,terms:prev.terms,valid_until:prev.valid_until?.toISOString()??null,active:false});
   for(const [key,q] of incoming){
    const prev=current.find(x=>x.offer_key===key);
    const snapshot={...context(q,l),evidence_path:o.evidence_path};
    const modified=!prev||prev.price_cents!==q.price_cents||prev.availability!==q.availability||prev.active!==q.active||stable(prev.terms)!==stable(q.terms)||(prev.valid_until?.toISOString()??null)!==q.valid_until;
    if(prev&&new Date(prev.last_checked_at)>new Date(o.observed_at))continue;
    if(modified&&prev&&(await db.query('select 1 from pricing.offer_history where offer_id=$1 and crawl_run_id=$2',[prev.id,runId])).rowCount)throw Error('CONFLICTING_STATES_WITHIN_ONE_RUN');
    const offer=(await db.query(`insert into pricing.offers(listing_id,offer_key,quantity,seller_key,location_key,program_key,price_cents,currency,availability,terms,active,last_checked_at,valid_until,crawl_run_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    on conflict(listing_id,offer_key) do update set price_cents=excluded.price_cents,availability=excluded.availability,terms=excluded.terms,active=excluded.active,
      last_checked_at=excluded.last_checked_at,valid_until=excluded.valid_until,crawl_run_id=excluded.crawl_run_id returning id`,
    [listing.id,key,q.quantity,q.seller_key,q.location_key,q.program_key,q.price_cents,q.currency,q.availability,JSON.stringify(q.terms),q.active,o.observed_at,q.valid_until,runId])).rows[0];
    if(modified){await db.query('insert into pricing.offer_history(offer_id,crawl_run_id,observed_at,price_cents,currency,availability,snapshot) values($1,$2,$3,$4,$5,$6,$7)',[offer.id,runId,o.observed_at,q.price_cents,q.currency,q.availability,JSON.stringify(snapshot)]);changed++;}
   }
   await db.query('update pricing.crawl_pages set listing_id=$3 where source_id=$1 and url=$2',[sourceId,l.url,listing.id]);
   return {listingId:listing.id,changed};
  });
 }
}
