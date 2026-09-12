import {createHash} from 'node:crypto';
import type pg from 'pg';
import {
 MedicationNormalizer,
 NORMALIZATION_VERSION,
 normalizeQuantityUnit,
 type CanonicalMedication,
 type NormalizationDecision,
 type RawMedicationIdentity,
} from './normalization.js';

type Database=pg.Pool|pg.PoolClient;
type Row=Record<string,any>;

export interface VerifiedBackup {
 sha256:string;
 created_at:string;
 restore_verified:boolean;
 format:string;
 database_state_hash:string;
}

export interface BackfillDecisionEvidence {
 listing_id:string|null;
 source_id:string|null;
 source:string|null;
 evidence_path:string;
 raw_identity:RawMedicationIdentity;
 proposed_content_unit:string|null;
 decision:NormalizationDecision;
}

export interface BackfillPlanItem {
 legacy_medication_id:string;
 raw_snapshot:{medication:Row;listings:Row[]};
 input_hash:string;
 decision_evidence:BackfillDecisionEvidence[];
 normalized_identity:CanonicalMedication|null;
 candidate_rxcuis:string[];
 decision_status:'ready'|'needs_review'|'unmatched';
 reason:string|null;
 proposed_normalized_key:string|null;
 proposed_survivor_id:string|null;
 proposed_listing_units:Record<string,string>;
 collision_group_size:number;
 approval_status:'pending'|'collision_review'|'requires_review'|'unmatched';
}

export interface BackfillPlan {
 normalization_version:string;
 terminology_version:string|null;
 snapshot_hash:string;
 baseline:BackfillSnapshot;
 summary:Record<string,number>;
 items:BackfillPlanItem[];
}

export interface BackfillSnapshot {
 counts:Record<string,number>;
 hashes:Record<string,string>;
 snapshot_hash:string;
 recovery_hash:string;
}

function canonicalize(value:any):any {
 if(value instanceof Date)return value.toISOString();
 if(Array.isArray(value))return value.map(canonicalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalize(value[key])]));
 return value;
}

function digest(value:any):string {
 return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function publicListing(row:Row):Row {
 const metadata={...(row.metadata??{})};delete metadata.normalization_backfill;
 return {
  id:String(row.id),source_id:String(row.source_id),source_product_key:row.source_product_key,
  source_name:row.source_name,url:row.url,brand_name:row.brand_name,sold_as:row.sold_as,
  match_status:row.match_status,metadata,
 };
}

async function queryRows(db:Database,sql:string,values:any[]=[]):Promise<Row[]> {
 return (await db.query(sql,values)).rows;
}

export async function captureBackfillSnapshot(db:Database):Promise<BackfillSnapshot> {
 const counts=(await queryRows(db,`select
  (select count(*)::int from pricing.medications) medications,
  (select count(*)::int from pricing.medication_components) medication_components,
  (select count(*)::int from pricing.listings) listings,
  (select count(*)::int from pricing.medication_matches) medication_matches,
  (select count(*)::int from pricing.crawl_pages) crawl_pages,
  (select count(*)::int from pricing.offers) offers,
  (select count(*)::int from pricing.offer_history) offer_history`))[0];
 const medications=await queryRows(db,'select * from pricing.medications order by id');
 const components=await queryRows(db,'select id,medication_id,sequence,ingredient_name,ingredient_rxcui,precise_ingredient_rxcui,numerator_value::text,numerator_unit,denominator_value::text,denominator_unit,backfill_run_id from pricing.medication_components order by id');
 const listings=await queryRows(db,'select * from pricing.listings order by id');
 const matches=await queryRows(db,'select id,source_id,listing_id,input_hash,raw_identity,normalized_identity,candidate_rxcuis,selected_medication_id,match_method,match_status,reason,normalization_version,terminology_version,evidence_path,created_at,backfill_run_id from pricing.medication_matches order by id');
 const pages=await queryRows(db,'select * from pricing.crawl_pages order by id');
 const offers=await queryRows(db,'select * from pricing.offers order by id');
 const history=await queryRows(db,'select * from pricing.offer_history order by id');
 const sources=await queryRows(db,'select * from pricing.sources order by id');
 const crawlRuns=await queryRows(db,'select * from pricing.crawl_runs order by id');
 const backfillRuns=await queryRows(db,'select * from pricing.medication_backfill_runs order by id');
 const backfillItems=await queryRows(db,'select * from pricing.medication_backfill_items order by id');
 const backfillEvents=await queryRows(db,'select * from pricing.medication_backfill_events order by id');
 const numericCounts=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)]));
 const hashes={
  medications:digest(medications),components:digest(components),listings:digest(listings),
  listings_immutable:digest(listings.map(publicListing)),matches:digest(matches),
  crawl_pages:digest(pages),offers:digest(offers),offer_history:digest(history),
 };
 const recovery_hash=digest({sources,medications,medication_backfill_runs:backfillRuns,medication_components:components,crawl_runs:crawlRuns,listings,medication_backfill_items:backfillItems,medication_backfill_events:backfillEvents,medication_matches:matches,crawl_pages:pages,offers,offer_history:history});
 return {counts:numericCounts,hashes,snapshot_hash:digest({counts:numericCounts,hashes}),recovery_hash};
}

function rawIdentity(medication:Row,listing?:Row):RawMedicationIdentity {
 const metadata=listing?.metadata??{},rawNdc=metadata.ndc;
 return {
  name:String(medication.name),strength:String(medication.strength),form:String(medication.form),
  route:String(medication.route),release_type:String(medication.release_type),
  brand_name:listing?.brand_name??medication.brand_name??null,
  ndc:typeof rawNdc==='string'&&/^\d{10,11}$/.test(rawNdc)?rawNdc:null,
  species:Array.isArray(metadata.species_labels)?metadata.species_labels.map(String):[],
 };
}

function sameCanonicalStructure(left:CanonicalMedication|Row,right:CanonicalMedication|Row):boolean {
 return ['strength','form','route','release_type','rxnorm_rxcui','rxnorm_term_type'].every(key=>(left as Row)[key]===(right as Row)[key]);
}

function summarize(items:BackfillPlanItem[]):Record<string,number> {
 return {
  legacy_medications:items.length,
  ready:items.filter(item=>item.decision_status==='ready').length,
  needs_review:items.filter(item=>item.decision_status==='needs_review').length,
  unmatched:items.filter(item=>item.decision_status==='unmatched').length,
  collision_review:items.filter(item=>item.approval_status==='collision_review').length,
  target_listings:items.reduce((total,item)=>total+item.raw_snapshot.listings.length,0),
 };
}

async function mapLimit<T,R>(values:T[],limit:number,fn:(value:T)=>Promise<R>):Promise<R[]> {
 const result=new Array<R>(values.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{
  while(true){const index=cursor++;if(index>=values.length)return;result[index]=await fn(values[index]);}
 }));
 return result;
}

export async function planMedicationBackfill(db:Database,normalizer:MedicationNormalizer):Promise<BackfillPlan> {
 const baseline=await captureBackfillSnapshot(db);
 const medications=await queryRows(db,"select * from pricing.medications where normalized_key is null and superseded_by_id is null order by id");
 const ids=medications.map(row=>String(row.id));
 const listings=ids.length?await queryRows(db,`select l.*,s.slug as source,
  coalesce((select h.snapshot->>'evidence_path' from pricing.offers o join pricing.offer_history h on h.offer_id=o.id where o.listing_id=l.id order by h.observed_at desc,h.id desc limit 1),'legacy://listing/'||l.id::text) as evidence_path
  from pricing.listings l join pricing.sources s on s.id=l.source_id where l.medication_id=any($1::bigint[]) order by l.id`,[ids]):[];
 const byMedication=new Map<string,Row[]>();for(const listing of listings){const key=String(listing.medication_id),found=byMedication.get(key)??[];found.push(listing);byMedication.set(key,found);}

 const items=await mapLimit(medications,4,async medication=>{
  const attached=byMedication.get(String(medication.id))??[];
  const inputs=attached.length?attached:[null];
  const evidence:BackfillDecisionEvidence[]=[];
  for(const listing of inputs){
   const raw=rawIdentity(medication,listing??undefined);
   const decision=await normalizer.normalize(raw,{reviewed:false});
   evidence.push({
    listing_id:listing?String(listing.id):null,source_id:listing?String(listing.source_id):null,
    source:listing?.source??null,evidence_path:listing?.evidence_path??`legacy://medication/${medication.id}`,
    raw_identity:raw,proposed_content_unit:listing?.content_unit?normalizeQuantityUnit(String(listing.content_unit)):null,decision,
   });
  }
  const verified=evidence.filter(item=>item.decision.status==='verified'&&item.decision.normalized);
  const normalizedKeys=new Set(verified.map(item=>item.decision.normalized!.normalized_key));
  const unsupportedUnit=attached.some((listing,index)=>listing.match_status==='verified'&&listing.content_unit!==null&&evidence[index].proposed_content_unit===null);
  const nonVerifiedListing=attached.some(listing=>listing.match_status!=='verified');
  let decisionStatus:BackfillPlanItem['decision_status'],reason:string|null,normalized:CanonicalMedication|null=null;
  if(nonVerifiedListing){decisionStatus='needs_review';reason='attached_listing_not_verified';}
  else if(unsupportedUnit){decisionStatus='needs_review';reason='unsupported_quantity_unit';}
  else if(verified.length===evidence.length&&normalizedKeys.size===1){
   normalized=verified[0].decision.normalized!;
   const structureAgrees=verified.every(item=>sameCanonicalStructure(normalized!,item.decision.normalized!));
   decisionStatus=structureAgrees?'ready':'needs_review';reason=structureAgrees?null:'canonical_structure_conflict';if(!structureAgrees)normalized=null;
  }else if(verified.length){decisionStatus='needs_review';reason='listing_identity_decisions_disagree';}
  else if(evidence.some(item=>item.decision.status==='needs_review')){decisionStatus='needs_review';reason=evidence.find(item=>item.decision.status==='needs_review')!.decision.reason;}
  else {decisionStatus='unmatched';reason=evidence[0]?.decision.reason??'no_normalization_candidate';}
  const candidateRxcuis=[...new Set(evidence.flatMap(item=>item.decision.candidates.map(candidate=>candidate.rxcui)))].sort();
  const proposedListingUnits=Object.fromEntries(evidence.filter(item=>item.listing_id&&item.proposed_content_unit).map(item=>[item.listing_id!,item.proposed_content_unit!]));
  return {
   legacy_medication_id:String(medication.id),raw_snapshot:{medication,listings:attached},
   input_hash:digest(evidence.map(item=>item.decision.input_hash)),decision_evidence:evidence,
   normalized_identity:normalized,candidate_rxcuis:candidateRxcuis,decision_status:decisionStatus,reason,
   proposed_normalized_key:normalized?.normalized_key??null,proposed_survivor_id:null,
   proposed_listing_units:proposedListingUnits,collision_group_size:1,
   approval_status:decisionStatus==='ready'?'pending':decisionStatus==='needs_review'?'requires_review':'unmatched',
  } satisfies BackfillPlanItem;
 });

 const active=await queryRows(db,"select * from pricing.medications where normalization_status='verified' and superseded_by_id is null order by id");
 const activeByKey=new Map(active.filter(row=>row.normalized_key).map(row=>[String(row.normalized_key),row]));
 const groups=new Map<string,BackfillPlanItem[]>();
 for(const item of items)if(item.decision_status==='ready'){const key=item.proposed_normalized_key!,group=groups.get(key)??[];group.push(item);groups.set(key,group);}
 for(const [key,group] of groups){
  const existing=activeByKey.get(key),normalized=group[0].normalized_identity!;
  if(existing&&!sameCanonicalStructure(existing,normalized)){
   for(const item of group){item.decision_status='needs_review';item.reason='active_canonical_collision_conflict';item.normalized_identity=null;item.proposed_normalized_key=null;item.approval_status='requires_review';}
   continue;
  }
  const survivor=existing?String(existing.id):group.map(item=>item.legacy_medication_id).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)[0];
  const collisionSize=group.length+(existing?1:0);
  for(const item of group){item.proposed_survivor_id=survivor;item.collision_group_size=collisionSize;item.approval_status=collisionSize>1?'collision_review':'pending';}
 }
 const versions=[...new Set(items.flatMap(item=>item.decision_evidence.map(e=>e.decision.terminology_version).filter((value):value is string=>Boolean(value))))];
 return {normalization_version:NORMALIZATION_VERSION,terminology_version:versions.length===1?versions[0]:null,snapshot_hash:baseline.snapshot_hash,baseline,summary:summarize(items),items};
}

function validActor(value:string):string {
 const actor=value.trim();if(actor.length<3||actor.length>120||/[\u0000-\u001f]/.test(actor))throw Error('INVALID_BACKFILL_ACTOR');return actor;
}

function validateBackup(backup:VerifiedBackup):void {
 const created=Date.parse(backup.created_at);
 if(backup.format!=='housemed-logical-backup-v3'||!backup.restore_verified||!/^([0-9a-f]{64})$/.test(backup.sha256)||!/^([0-9a-f]{64})$/.test(backup.database_state_hash)||!Number.isFinite(created)||created>Date.now()+300000)throw Error('RESTORE_VERIFIED_BACKUP_REQUIRED');
}

async function inTransaction<T>(pool:pg.Pool,fn:(db:pg.PoolClient)=>Promise<T>):Promise<T> {
 const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(error){await db.query('rollback');throw error;}finally{db.release();}
}

export async function stageMedicationBackfill(pool:pg.Pool,normalizer:MedicationNormalizer,backup:VerifiedBackup,actorValue:string):Promise<BackfillPlan&{run_id:string}> {
 validateBackup(backup);const actor=validActor(actorValue),plan=await planMedicationBackfill(pool,normalizer);
 if(!plan.items.length)throw Error('BACKFILL_NO_LEGACY_MEDICATIONS');
 if(backup.database_state_hash!==plan.baseline.recovery_hash)throw Error('BACKUP_DATABASE_STATE_MISMATCH');
 const current=await captureBackfillSnapshot(pool);if(current.snapshot_hash!==plan.snapshot_hash)throw Error('BACKFILL_SNAPSHOT_CHANGED_DURING_PLANNING');
 return inTransaction(pool,async db=>{
  await db.query("select pg_advisory_xact_lock(hashtextextended('housemed:medication-backfill',0))");
  const run=(await db.query(`insert into pricing.medication_backfill_runs(normalization_version,terminology_version,snapshot_hash,backup_sha256,backup_database_state_hash,backup_created_at,backup_restore_verified,baseline,summary)
   values($1,$2,$3,$4,$5,$6,true,$7,$8) returning id`,[plan.normalization_version,plan.terminology_version,plan.snapshot_hash,backup.sha256,backup.database_state_hash,backup.created_at,JSON.stringify(plan.baseline),JSON.stringify(plan.summary)])).rows[0];
  for(const item of plan.items)await db.query(`insert into pricing.medication_backfill_items(run_id,legacy_medication_id,raw_snapshot,input_hash,decision_evidence,normalized_identity,candidate_rxcuis,decision_status,reason,proposed_normalized_key,proposed_survivor_id,proposed_listing_units,collision_group_size,approval_status)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[run.id,item.legacy_medication_id,JSON.stringify(item.raw_snapshot),item.input_hash,JSON.stringify(item.decision_evidence),item.normalized_identity?JSON.stringify(item.normalized_identity):null,JSON.stringify(item.candidate_rxcuis),item.decision_status,item.reason,item.proposed_normalized_key,item.proposed_survivor_id,JSON.stringify(item.proposed_listing_units),item.collision_group_size,item.approval_status]);
  await db.query("insert into pricing.medication_backfill_events(run_id,event_type,actor,payload) values($1,'staged',$2,$3)",[run.id,actor,JSON.stringify({snapshot_hash:plan.snapshot_hash,summary:plan.summary,backup_sha256:backup.sha256,backup_database_state_hash:backup.database_state_hash})]);
  return {...plan,run_id:String(run.id)};
 });
}

export function backfillConfirmation(action:'apply'|'compensate',runId:string,snapshotHash:string):string {
 return `${action}:${runId}:${snapshotHash}`;
}

export async function approveMedicationBackfill(pool:pg.Pool,runId:string,actorValue:string,approveCollisions=false):Promise<{run_id:string;approved:number;unresolved:number;confirmation:string}> {
 const actor=validActor(actorValue);if(!/^[1-9]\d*$/.test(runId))throw Error('INVALID_BACKFILL_RUN_ID');
 return inTransaction(pool,async db=>{
  await db.query("select pg_advisory_xact_lock(hashtextextended('housemed:medication-backfill',0))");
  const run=(await db.query('select * from pricing.medication_backfill_runs where id=$1 for update',[runId])).rows[0];if(!run||run.status!=='staged')throw Error('BACKFILL_RUN_NOT_STAGED');
  const current=await captureBackfillSnapshot(db);if(current.snapshot_hash!==run.snapshot_hash)throw Error('BACKFILL_SNAPSHOT_STALE');
  await db.query("update pricing.medication_backfill_items set approval_status='approved',approved_at=now(),approved_by=$2 where run_id=$1 and approval_status='pending'",[runId,actor]);
  if(approveCollisions)await db.query("update pricing.medication_backfill_items set approval_status='approved',approved_at=now(),approved_by=$2 where run_id=$1 and approval_status='collision_review'",[runId,actor]);
  const counts=(await db.query("select count(*) filter(where approval_status='approved')::int approved,count(*) filter(where approval_status<>'approved')::int unresolved from pricing.medication_backfill_items where run_id=$1",[runId])).rows[0];
  if(!counts.approved)throw Error('BACKFILL_HAS_NO_APPROVED_ITEMS');
  await db.query("update pricing.medication_backfill_runs set status='approved',approved_at=now(),approved_by=$2,summary=summary||$3::jsonb where id=$1",[runId,actor,JSON.stringify({approved_items:counts.approved,unresolved_items:counts.unresolved,collisions_approved:approveCollisions})]);
  await db.query("insert into pricing.medication_backfill_events(run_id,event_type,actor,payload) values($1,'approved',$2,$3)",[runId,actor,JSON.stringify({approved_items:counts.approved,unresolved_items:counts.unresolved,collisions_approved:approveCollisions})]);
  return {run_id:runId,approved:counts.approved,unresolved:counts.unresolved,confirmation:backfillConfirmation('apply',runId,run.snapshot_hash)};
 });
}

function medicationValues(medication:Row):any[] {
 return [medication.name,medication.strength,medication.form,medication.route,medication.release_type,medication.canonical_name,medication.normalized_name,medication.normalized_key,medication.rxnorm_rxcui,medication.rxnorm_term_type,medication.normalization_status,medication.normalization_version,medication.terminology_version,medication.superseded_by_id,medication.brand_name];
}

async function assertCurrentSnapshot(db:Database,run:Row):Promise<void> {
 const current=await captureBackfillSnapshot(db);if(current.snapshot_hash!==run.snapshot_hash)throw Error('BACKFILL_SNAPSHOT_STALE');
}

function reconciliation(before:BackfillSnapshot,after:BackfillSnapshot):Row {
 for(const table of ['medications','listings','crawl_pages','offers','offer_history'])if(after.counts[table]!==before.counts[table])throw Error('BACKFILL_COUNT_MISMATCH_'+table.toUpperCase());
 for(const key of ['listings_immutable','crawl_pages','offers','offer_history'])if(after.hashes[key]!==before.hashes[key])throw Error('BACKFILL_IMMUTABLE_HASH_MISMATCH_'+key.toUpperCase());
 return {before_counts:before.counts,after_counts:after.counts,immutable_hashes:Object.fromEntries(['listings_immutable','crawl_pages','offers','offer_history'].map(key=>[key,after.hashes[key]]))};
}

async function ensureComponents(db:pg.PoolClient,medicationId:string,normalized:CanonicalMedication,runId:string):Promise<void> {
 const existing=await queryRows(db,'select sequence,numerator_value::text,numerator_unit,denominator_value::text,denominator_unit from pricing.medication_components where medication_id=$1 order by sequence',[medicationId]);
 if(existing.length){
  if(existing.length!==normalized.components.length||existing.some((row,index)=>row.sequence!==normalized.components[index].sequence||row.numerator_value!==normalized.components[index].numerator_value||row.numerator_unit!==normalized.components[index].numerator_unit||row.denominator_value!==normalized.components[index].denominator_value||row.denominator_unit!==normalized.components[index].denominator_unit))throw Error('BACKFILL_COMPONENT_CONFLICT');
  return;
 }
 for(const component of normalized.components)await db.query(`insert into pricing.medication_components(medication_id,sequence,ingredient_name,ingredient_rxcui,precise_ingredient_rxcui,numerator_value,numerator_unit,denominator_value,denominator_unit,backfill_run_id)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[medicationId,component.sequence,component.ingredient_name,component.ingredient_rxcui,component.precise_ingredient_rxcui,component.numerator_value,component.numerator_unit,component.denominator_value,component.denominator_unit,runId]);
}

export async function applyMedicationBackfill(pool:pg.Pool,runId:string,actorValue:string,confirmation:string):Promise<{run_id:string;status:'applied';reconciliation:Row}> {
 const actor=validActor(actorValue);if(!/^[1-9]\d*$/.test(runId))throw Error('INVALID_BACKFILL_RUN_ID');
 let applicationStarted=false;
 try{return await inTransaction(pool,async db=>{
  await db.query("select pg_advisory_xact_lock(hashtextextended('housemed:medication-backfill',0))");
  const run=(await db.query('select * from pricing.medication_backfill_runs where id=$1 for update',[runId])).rows[0];if(!run||run.status!=='approved')throw Error('BACKFILL_RUN_NOT_APPROVED');
  if(confirmation!==backfillConfirmation('apply',runId,run.snapshot_hash))throw Error('BACKFILL_CONFIRMATION_MISMATCH');
  await assertCurrentSnapshot(db,run);
  applicationStarted=true;
  const items=await queryRows(db,"select * from pricing.medication_backfill_items where run_id=$1 and approval_status='approved' order by proposed_survivor_id,id for update",[runId]);if(!items.length)throw Error('BACKFILL_HAS_NO_APPROVED_ITEMS');
  await db.query("update pricing.medication_backfill_runs set status='applying' where id=$1",[runId]);
  await db.query("insert into pricing.medication_backfill_events(run_id,event_type,actor,payload) values($1,'applying',$2,$3)",[runId,actor,JSON.stringify({approved_items:items.length})]);
  const groups=new Map<string,Row[]>();for(const item of items){const key=String(item.proposed_survivor_id),group=groups.get(key)??[];group.push(item);groups.set(key,group);}
  for(const [survivorId,group] of groups){
   const normalized=group[0].normalized_identity as CanonicalMedication;
   if(!normalized||group.some(item=>item.proposed_normalized_key!==normalized.normalized_key||item.normalized_identity?.normalized_key!==normalized.normalized_key))throw Error('BACKFILL_GROUP_DECISION_CONFLICT');
   const survivor=(await db.query('select * from pricing.medications where id=$1 for update',[survivorId])).rows[0];if(!survivor||survivor.superseded_by_id!==null)throw Error('BACKFILL_SURVIVOR_NOT_ACTIVE');
   if(survivor.normalized_key===null){
    await db.query(`update pricing.medications set name=$2,strength=$3,form=$4,route=$5,release_type=$6,canonical_name=$7,normalized_name=$8,normalized_key=$9,rxnorm_rxcui=$10,rxnorm_term_type=$11,normalization_status='verified',normalization_version=$12,terminology_version=$13,brand_name=$14 where id=$1`,[survivorId,normalized.name,normalized.strength,normalized.form,normalized.route,normalized.release_type,normalized.canonical_name,normalized.normalized_name,normalized.normalized_key,normalized.rxnorm_rxcui,normalized.rxnorm_term_type,normalized.normalization_version,normalized.terminology_version,null]);
   }else if(survivor.normalized_key!==normalized.normalized_key||!sameCanonicalStructure(survivor,normalized))throw Error('BACKFILL_SURVIVOR_CONFLICT');
   await ensureComponents(db,survivorId,normalized,runId);
   for(const item of group){
    const original=item.raw_snapshot as {medication:Row;listings:Row[]};
    const current=(await db.query('select * from pricing.medications where id=$1 for update',[item.legacy_medication_id])).rows[0];if(!current)throw Error('BACKFILL_LEGACY_MEDICATION_MISSING');
    if(String(item.legacy_medication_id)!==survivorId){
     if(current.normalized_key!==null||current.superseded_by_id!==null)throw Error('BACKFILL_LEGACY_MEDICATION_CHANGED');
     await db.query("update pricing.medications set normalization_status='superseded',normalization_version=$2,terminology_version=$3,superseded_by_id=$4 where id=$1",[item.legacy_medication_id,NORMALIZATION_VERSION,normalized.terminology_version,survivorId]);
    }
    const evidence=item.decision_evidence as BackfillDecisionEvidence[];
    for(const listing of original.listings){
     const listingId=String(listing.id),decision=evidence.find(entry=>entry.listing_id===listingId);if(!decision||decision.decision.status!=='verified')throw Error('BACKFILL_LISTING_DECISION_MISSING');
     const unit=(item.proposed_listing_units as Record<string,string>)[listingId];if(!unit)throw Error('BACKFILL_LISTING_UNIT_MISSING');
     const changed=await db.query(`update pricing.listings set medication_id=$2,content_unit=$3,
      metadata=metadata||jsonb_build_object('normalization_backfill',jsonb_build_object('run_id',$4::text,'legacy_medication_id',$5::text,'normalization_version',$6::text))
      where id=$1 and medication_id=$5 and match_status='verified'`,[listingId,survivorId,unit,runId,item.legacy_medication_id,NORMALIZATION_VERSION]);
     if(changed.rowCount!==1)throw Error('BACKFILL_LISTING_CHANGED');
     await db.query(`insert into pricing.medication_matches(source_id,listing_id,input_hash,raw_identity,normalized_identity,candidate_rxcuis,selected_medication_id,match_method,match_status,reason,normalization_version,terminology_version,evidence_path,backfill_run_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,'verified',$9,$10,$11,$12,$13)`,[decision.source_id,listingId,decision.decision.input_hash,JSON.stringify(decision.raw_identity),JSON.stringify(decision.decision.normalized),JSON.stringify(decision.decision.candidates.map(candidate=>candidate.rxcui)),survivorId,decision.decision.method,decision.decision.reason,NORMALIZATION_VERSION,decision.decision.terminology_version,decision.evidence_path,runId]);
    }
    await db.query("update pricing.medication_backfill_items set approval_status='applied',applied_at=now() where id=$1",[item.id]);
   }
  }
  const expectedMatches=items.reduce((total,item)=>total+(item.raw_snapshot.listings as Row[]).length,0);
  const audit=(await db.query("select (select count(*)::int from pricing.medication_matches where backfill_run_id=$1) matches,(select count(*)::int from pricing.medication_backfill_items where run_id=$1 and approval_status='applied') applied_items",[runId])).rows[0];
  if(audit.matches!==expectedMatches||audit.applied_items!==items.length)throw Error('BACKFILL_AUDIT_ROW_MISMATCH');
  const after=await captureBackfillSnapshot(db),checked=reconciliation(run.baseline as BackfillSnapshot,after);
  await db.query("update pricing.medication_backfill_runs set status='applied',applied_at=now(),reconciliation=$2 where id=$1",[runId,JSON.stringify(checked)]);
  await db.query("insert into pricing.medication_backfill_events(run_id,event_type,actor,payload) values($1,'applied',$2,$3)",[runId,actor,JSON.stringify(checked)]);
  return {run_id:runId,status:'applied' as const,reconciliation:checked};
 });}catch(error){
  if(applicationStarted)await inTransaction(pool,async db=>{const failure=error instanceof Error?error.message.slice(0,200):'BACKFILL_APPLY_FAILED';await db.query("update pricing.medication_backfill_runs set status='failed',failure_code=$2 where id=$1 and status='approved'",[runId,failure]);await db.query("insert into pricing.medication_backfill_events(run_id,event_type,actor,payload) select id,'failed',$2,$3 from pricing.medication_backfill_runs where id=$1",[runId,actor,JSON.stringify({failure_code:failure})]);}).catch(()=>{});
  throw error;
 }
}

export async function compensateMedicationBackfill(pool:pg.Pool,runId:string,actorValue:string,confirmation:string):Promise<{run_id:string;status:'compensated';reconciliation:Row}> {
 const actor=validActor(actorValue);if(!/^[1-9]\d*$/.test(runId))throw Error('INVALID_BACKFILL_RUN_ID');
 return inTransaction(pool,async db=>{
  await db.query("select pg_advisory_xact_lock(hashtextextended('housemed:medication-backfill',0))");
  const run=(await db.query('select * from pricing.medication_backfill_runs where id=$1 for update',[runId])).rows[0];if(!run||run.status!=='applied')throw Error('BACKFILL_RUN_NOT_APPLIED');
  if(confirmation!==backfillConfirmation('compensate',runId,run.snapshot_hash))throw Error('BACKFILL_CONFIRMATION_MISMATCH');
  const items=await queryRows(db,"select * from pricing.medication_backfill_items where run_id=$1 and approval_status='applied' order by id for update",[runId]);
  const targetListingIds=new Set(items.flatMap(item=>(item.raw_snapshot.listings as Row[]).map(listing=>String(listing.id))));
  const legacyIds=new Set(items.map(item=>String(item.legacy_medication_id)));
  const legacySurvivors=[...new Set(items.map(item=>String(item.proposed_survivor_id)).filter(id=>legacyIds.has(id)))];
  if(legacySurvivors.length){const foreign=await queryRows(db,'select id from pricing.listings where medication_id=any($1::bigint[])',[legacySurvivors]);if(foreign.some(row=>!targetListingIds.has(String(row.id))))throw Error('BACKFILL_COMPENSATION_HAS_NEW_REFERENCES');}
  for(const item of items)for(const listing of item.raw_snapshot.listings as Row[]){const current=(await db.query("select medication_id,metadata->'normalization_backfill'->>'run_id' run_id from pricing.listings where id=$1 for update",[listing.id])).rows[0];if(!current||String(current.medication_id)!==String(item.proposed_survivor_id)||current.run_id!==runId)throw Error('BACKFILL_COMPENSATION_LISTING_CHANGED');}
  for(const survivorId of legacySurvivors)await db.query("update pricing.medications set canonical_name=null,normalized_name=null,normalized_key=null,rxnorm_rxcui=null,rxnorm_term_type=null,normalization_status=null,normalization_version=null,terminology_version=null,superseded_by_id=null where id=$1",[survivorId]);
  for(const item of items){
   const original=item.raw_snapshot as {medication:Row;listings:Row[]},values=medicationValues(original.medication);
   await db.query(`update pricing.medications set name=$2,strength=$3,form=$4,route=$5,release_type=$6,canonical_name=$7,normalized_name=$8,normalized_key=$9,rxnorm_rxcui=$10,rxnorm_term_type=$11,normalization_status=$12,normalization_version=$13,terminology_version=$14,superseded_by_id=$15,brand_name=$16 where id=$1`,[item.legacy_medication_id,...values]);
   for(const listing of original.listings)await db.query('update pricing.listings set medication_id=$2,content_unit=$3,metadata=$4 where id=$1',[listing.id,listing.medication_id,listing.content_unit,JSON.stringify(listing.metadata)]);
   await db.query("update pricing.medication_backfill_items set approval_status='compensated',compensated_at=now() where id=$1",[item.id]);
  }
  await db.query('delete from pricing.medication_components where backfill_run_id=$1',[runId]);
  const after=await captureBackfillSnapshot(db),checked=reconciliation(run.baseline as BackfillSnapshot,after);
  const baseline=run.baseline as BackfillSnapshot;
  if(after.counts.medication_components!==baseline.counts.medication_components||after.hashes.medications!==baseline.hashes.medications||after.hashes.components!==baseline.hashes.components||after.hashes.listings!==baseline.hashes.listings)throw Error('BACKFILL_COMPENSATION_RECONCILIATION_FAILED');
  await db.query("update pricing.medication_backfill_runs set status='compensated',compensated_at=now(),reconciliation=$2 where id=$1",[runId,JSON.stringify({...checked,match_evidence_retained:true})]);
  await db.query("insert into pricing.medication_backfill_events(run_id,event_type,actor,payload) values($1,'compensated',$2,$3)",[runId,actor,JSON.stringify({...checked,match_evidence_retained:true})]);
  return {run_id:runId,status:'compensated' as const,reconciliation:checked};
 });
}

export async function getMedicationBackfillStatus(db:Database,runId?:string):Promise<Row|null> {
 const rows=await queryRows(db,runId?'select id,status,normalization_version,terminology_version,snapshot_hash,summary,reconciliation,created_at,approved_at,approved_by,applied_at,compensated_at,failure_code from pricing.medication_backfill_runs where id=$1':'select id,status,normalization_version,terminology_version,snapshot_hash,summary,reconciliation,created_at,approved_at,approved_by,applied_at,compensated_at,failure_code from pricing.medication_backfill_runs order by id desc limit 1',runId?[runId]:[]);
 return rows[0]??null;
}
