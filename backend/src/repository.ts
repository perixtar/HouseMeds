import type pg from 'pg';
import {transaction} from './db.js';
import {assertObservation,offerKey,stable,type SourceSlug,type Observation,type Quote,type Json,type Listing} from './core.js';
import {MedicationNormalizer,NORMALIZATION_VERSION,normalizeQuantityUnit,type NormalizationDecision} from './normalization.js';

function context(q:Quote,l:Listing):Json{return {quantity:q.quantity,seller_key:q.seller_key,location_key:q.location_key,program_key:q.program_key,terms:q.terms,active:q.active,valid_until:q.valid_until,package:{source_name:l.source_name,sold_as:l.sold_as,content_quantity:l.content_quantity,content_unit:l.content_unit,brand_name:l.brand_name}};}

export class Repository {
 constructor(public pool:pg.Pool,private readonly normalizer=new MedicationNormalizer()){}
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
  const rawIdentity=o.listing.medication?{...o.listing.medication,brand_name:o.listing.brand_name,ndc:typeof o.listing.metadata.ndc==='string'?o.listing.metadata.ndc:null,species:Array.isArray(o.listing.metadata.species_labels)?o.listing.metadata.species_labels.map(String):[]}:o.listing.identity_candidate;
  const legacyAlreadyLinked=rawIdentity&&Boolean((await this.pool.query(`select 1 from pricing.listings l join pricing.medications m on m.id=l.medication_id
   where l.source_id=$1 and l.source_product_key=$2 and m.normalized_key is null limit 1`,[sourceId,o.listing.source_product_key])).rowCount);
  const decision=rawIdentity&&!legacyAlreadyLinked?await this.normalizer.normalize(rawIdentity,{reviewed:Boolean(o.listing.medication)}):null;
  const rawContentUnit=o.listing.content_unit,normalizedContentUnit=rawContentUnit?normalizeQuantityUnit(rawContentUnit):null;
  const l:Listing={...o.listing,content_unit:normalizedContentUnit,metadata:{...o.listing.metadata,...(rawContentUnit&&rawContentUnit!==normalizedContentUnit?{raw_content_unit:rawContentUnit}:{}),...(decision?{normalization:{status:decision.status,method:decision.method,reason:decision.reason,input_hash:decision.input_hash,normalization_version:NORMALIZATION_VERSION,terminology_version:decision.terminology_version,candidate_rxcuis:decision.candidates.map(x=>x.rxcui)}}:{})}};
  return transaction(this.pool,async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[sourceId+':'+l.source_product_key]);
   const run=await db.query('select source_id from pricing.crawl_runs where id=$1 and status=\'running\'',[runId]);
   if(run.rows[0]?.source_id!==sourceId)throw Error('INVALID_OBSERVATION_RUN');
   const old=(await db.query('select * from pricing.listings where source_id=$1 and source_product_key=$2 for update',[sourceId,l.source_product_key])).rows[0];let reuseExistingMatch=false,legacyExistingMedication=false;
   if(old){
    const latest=(await db.query('select max(last_checked_at) as time from pricing.offers where listing_id=$1',[old.id])).rows[0].time;
    if(latest&&new Date(latest)>new Date(o.observed_at))return {listingId:old.id,changed:0,ignored:'older_observation'};
    const fields=['source_name','sold_as','content_quantity','content_unit','brand_name'] as const;
    let conflict=fields.some(k=>old[k]!==null&&l[k]!==null&&String(old[k])!==String(l[k]));
    reuseExistingMatch=old.match_status==='verified'&&old.metadata?.normalization?.input_hash===decision?.input_hash&&decision?.reason==='terminology_resolver_unavailable';
    if(old.medication_id!==null){
     const medication=(await db.query('select name,strength,form,route,release_type,normalized_key from pricing.medications where id=$1',[old.medication_id])).rows[0];
     legacyExistingMedication=medication.normalized_key===null;
     if(rawIdentity&&!reuseExistingMatch){
      if(legacyExistingMedication&&o.listing.medication)conflict ||= (['name','strength','form','route','release_type'] as const).some(k=>medication[k]!==o.listing.medication![k]);
      else if(!legacyExistingMedication)conflict ||= medication.normalized_key&&decision?.normalized?(decision.method==='reviewed_input'?(['name','strength','form','route','release_type'] as const).some(k=>medication[k]!==decision.normalized![k]):medication.normalized_key!==decision.normalized.normalized_key):true;
     }
    }
    if(conflict){await db.query("update pricing.listings set match_status='needs_review',metadata=metadata||$2::jsonb where id=$1",[old.id,JSON.stringify({identity_conflict_evidence:o.evidence_path})]);return {listingId:old.id,changed:0,ignored:'identity_conflict'};}
   }
   let medId=old?.medication_id??null;
   if(decision?.status==='verified'&&decision.normalized&&medId===null)medId=await this.upsertNormalizedMedication(db,decision);
   const matched=medId!==null&&(decision?.status==='verified'||reuseExistingMatch)&&l.content_quantity!==null&&l.content_unit!==null;
   const matchStatus=legacyExistingMedication?old.match_status:matched?'verified':decision?.status==='needs_review'?'needs_review':'unmatched';
   let metadataForWrite=l.metadata;
   if(legacyExistingMedication){const {normalization:discarded,...withoutIncomingNormalization}=l.metadata;void discarded;metadataForWrite=old.metadata?.normalization?{...withoutIncomingNormalization,normalization:old.metadata.normalization}:withoutIncomingNormalization;}
   else if(reuseExistingMatch)metadataForWrite={...l.metadata,normalization:old.metadata.normalization};
   const listing=(await db.query(`insert into pricing.listings(source_id,source_product_key,medication_id,source_name,url,brand_name,sold_as,content_quantity,content_unit,match_status,metadata)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict(source_id,source_product_key) do update set medication_id=excluded.medication_id,source_name=excluded.source_name,url=excluded.url,
     brand_name=excluded.brand_name,sold_as=excluded.sold_as,content_quantity=excluded.content_quantity,content_unit=excluded.content_unit,
     match_status=case when pricing.listings.match_status='needs_review' then 'needs_review' else excluded.match_status end,metadata=pricing.listings.metadata||excluded.metadata returning id`,
    [sourceId,l.source_product_key,medId,l.source_name,l.url,l.brand_name,l.sold_as,l.content_quantity,l.content_unit,matchStatus,JSON.stringify(metadataForWrite)])).rows[0];
   if(decision&&rawIdentity&&!legacyExistingMedication&&!reuseExistingMatch)await db.query(`insert into pricing.medication_matches(source_id,listing_id,input_hash,raw_identity,normalized_identity,candidate_rxcuis,selected_medication_id,match_method,match_status,reason,normalization_version,terminology_version,evidence_path)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict do nothing`,[sourceId,listing.id,decision.input_hash,JSON.stringify(rawIdentity),decision.normalized?JSON.stringify(decision.normalized):null,JSON.stringify(decision.candidates.map(x=>x.rxcui)),decision.status==='verified'?medId:null,decision.method,decision.status,decision.reason,NORMALIZATION_VERSION,decision.terminology_version,o.evidence_path]);
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
 private async upsertNormalizedMedication(db:pg.PoolClient,decision:NormalizationDecision):Promise<string>{
  const m=decision.normalized!;
  const medication=(await db.query(`insert into pricing.medications(name,strength,form,route,release_type,canonical_name,normalized_name,normalized_key,rxnorm_rxcui,rxnorm_term_type,normalization_status,normalization_version,terminology_version,brand_name)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verified',$11,$12,$13)
   on conflict(normalized_key) where normalization_status='verified' and superseded_by_id is null do update set canonical_name=excluded.canonical_name,terminology_version=coalesce(excluded.terminology_version,pricing.medications.terminology_version) returning id`,
   [m.name,m.strength,m.form,m.route,m.release_type,m.canonical_name,m.normalized_name,m.normalized_key,m.rxnorm_rxcui,m.rxnorm_term_type,m.normalization_version,m.terminology_version,null])).rows[0];
  for(const component of m.components){
   await db.query(`insert into pricing.medication_components(medication_id,sequence,ingredient_name,ingredient_rxcui,precise_ingredient_rxcui,numerator_value,numerator_unit,denominator_value,denominator_unit)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(medication_id,sequence) do nothing`,[medication.id,component.sequence,component.ingredient_name,component.ingredient_rxcui,component.precise_ingredient_rxcui,component.numerator_value,component.numerator_unit,component.denominator_value,component.denominator_unit]);
   const saved=(await db.query('select ingredient_name,numerator_value::text,numerator_unit,denominator_value::text,denominator_unit from pricing.medication_components where medication_id=$1 and sequence=$2',[medication.id,component.sequence])).rows[0];
   if(!saved||saved.ingredient_name!==component.ingredient_name||saved.numerator_value!==component.numerator_value||saved.numerator_unit!==component.numerator_unit||saved.denominator_value!==component.denominator_value||saved.denominator_unit!==component.denominator_unit)throw Error('NORMALIZED_COMPONENT_CONFLICT');
  }
  return medication.id;
 }
}
