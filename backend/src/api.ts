import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { makePool } from './db.js';
import { quantity } from './core.js';
const idPattern='^[1-9][0-9]{0,17}$';
const sourceValues=['healthwarehouse','costplus'];
type OfferQuery={quantity?:string;unit?:string;source?:string;location?:string;program?:string;include_estimates?:boolean;limit?:number;cursor?:string};
const offerSchema={params:{type:'object',required:['id'],properties:{id:{type:'string',pattern:idPattern}}},querystring:{type:'object',additionalProperties:false,properties:{quantity:{type:'string',pattern:'^[0-9]+(?:\\.[0-9]+)?$',maxLength:24},unit:{type:'string',pattern:'^[a-z_]+$',maxLength:32},source:{type:'string',enum:sourceValues},location:{type:'string',maxLength:64},program:{type:'string',maxLength:64},include_estimates:{type:'boolean',default:false},limit:{type:'integer',minimum:1,maximum:100,default:50},cursor:{type:'string',pattern:idPattern}}}};
const listingColumns=`l.id as listing_id,s.slug as source,l.source_name,l.brand_name,l.url as purchase_url,l.sold_as,l.content_quantity,l.content_unit,l.match_status,
 case when l.match_status='verified' then l.medication_id end as medication_id,
 case when m.id is not null then jsonb_build_object('id',m.id::text,'name',m.name,'strength',m.strength,'form',m.form,'route',m.route,'release_type',m.release_type) end as medication`;
const listingJoins="from pricing.listings l join pricing.sources s on s.id=l.source_id left join pricing.medications m on m.id=l.medication_id and l.match_status='verified'";
const matchingRule=(sourceOnly:boolean)=>sourceOnly?"l.match_status<>'needs_review'":"l.match_status='verified'";
const availabilityRule=(includeEstimates:boolean)=>includeEstimates?"coalesce((o.availability='in_stock' or (o.availability='unknown' and o.terms->>'quote_kind'='estimate' and o.terms->>'availability_basis'='not_provided_by_api')),false)":"o.availability='in_stock'";
const eligible=(includeEstimates:boolean,sourceOnly:boolean)=>`${matchingRule(sourceOnly)} and l.content_quantity is not null and l.content_unit is not null and s.enabled
 and o.active and ${availabilityRule(includeEstimates)} and o.price_cents is not null
 and o.last_checked_at>=$1::timestamptz-interval '24 hours' and (o.valid_until is null or o.valid_until>$1::timestamptz)`;
export function buildApi(pool:pg.Pool,token:string){
 if(token.length<32)throw Error('API_TOKEN_TOO_SHORT');
 const app=Fastify({logger:false,bodyLimit:16384,requestTimeout:10000});
 const tokenHash=createHash('sha256').update('Bearer '+token).digest();
 app.addHook('onRequest',async(req,reply)=>{const supplied=req.headers.authorization??'';if(!timingSafeEqual(createHash('sha256').update(supplied).digest(),tokenHash))return reply.code(401).send({error:'unauthorized'});});
 app.setErrorHandler((error,req,reply)=>{if((error as {validation?:unknown}).validation)return reply.code(400).send({error:'invalid_request'});req.log.error({code:(error as {code?:string}).code},'Request failed');return reply.code(503).send({error:'service_unavailable'});});
 async function status(){
  const {rows}=await pool.query(`select s.slug as source,s.enabled,r.status as latest_run_status,r.started_at as latest_run_started_at,
   r.finished_at as latest_run_finished_at,(select max(finished_at) from pricing.crawl_runs where source_id=s.id and status='succeeded') as last_successful_run_at,
   coalesce(c.listings,0)::int as listings,coalesce(c.verified,0)::int as verified_listings,
   coalesce(p.fresh,0)::int as fresh_eligible_offers,coalesce(p.stale,0)::int as stale_offers
  from pricing.sources s left join lateral(select status,started_at,finished_at from pricing.crawl_runs where source_id=s.id order by started_at desc,id desc limit 1) r on true
  left join lateral(select count(*) as listings,count(*) filter(where match_status='verified') as verified from pricing.listings where source_id=s.id) c on true
  left join lateral(select count(*) filter(where o.active and o.availability='in_stock' and o.price_cents is not null and l.match_status='verified' and l.content_quantity is not null and l.content_unit is not null and s.enabled and o.last_checked_at>=now()-interval '24 hours' and (o.valid_until is null or o.valid_until>now())) as fresh,
  count(*) filter(where o.last_checked_at<now()-interval '24 hours' or o.valid_until<=now()) as stale from pricing.offers o join pricing.listings l on l.id=o.listing_id where l.source_id=s.id) p on true order by s.slug`);
  return rows;
 }
 app.get('/v1/sources/status',async()=>({as_of:new Date().toISOString(),sources:await status()}));
 app.get<{Querystring:{q?:string;limit?:number;cursor?:string}}>('/v1/medications',{schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',minLength:2,maxLength:120},limit:{type:'integer',minimum:1,maximum:100,default:30},cursor:{type:'string',pattern:idPattern}}}}},async(req)=>{
  const limit=req.query.limit??30,search=req.query.q?.replace(/[\\%_]/g,'\\$&')??null;
  const {rows}=await pool.query(`select id,name,strength,form,route,release_type from pricing.medications where ($1::text is null or name ilike '%'||$1||'%' escape '\\') and id>$2::bigint order by id limit $3`,[search,req.query.cursor??'0',limit+1]);
  const more=rows.length>limit;return {items:rows.slice(0,limit),next_cursor:more?rows[limit-1].id:null};
 });
 app.get<{Querystring:{q?:string;source?:string;limit?:number;cursor?:string}}>('/v1/listings',{schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',minLength:2,maxLength:120},source:{type:'string',enum:sourceValues},limit:{type:'integer',minimum:1,maximum:100,default:20},cursor:{type:'string',pattern:idPattern}}}}},async(req)=>{
  const limit=req.query.limit??20,search=req.query.q?.replace(/[\\%_]/g,'\\$&')??null;
  const {rows}=await pool.query(`select ${listingColumns} ${listingJoins} where ($1::text is null or l.source_name ilike '%'||$1||'%' escape '\\')
   and ($2::text is null or s.slug=$2) and l.id>$3::bigint order by l.id limit $4`,[search,req.query.source??null,req.query.cursor??'0',limit+1]);
  return {items:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].listing_id:null};
 });
 for(const sourceOnly of [false,true]){
 const route=sourceOnly?'/v1/listings/:id/offers':'/v1/medications/:id/offers';
 app.get<{Params:{id:string};Querystring:OfferQuery}>(route,{schema:offerSchema},async(req,reply)=>{
  const query=req.query,includeEstimates=req.query.include_estimates===true;
  if(Boolean(query.quantity)!==Boolean(query.unit))return reply.code(400).send({error:'quantity_and_unit_required_together'});
  let q:string|null=null;try{q=query.quantity?quantity(query.quantity):null;}catch{return reply.code(400).send({error:'invalid_quantity'});}
  const entity=(await pool.query(sourceOnly?`select ${listingColumns} ${listingJoins} where l.id=$1`:'select id,name,strength,form,route,release_type from pricing.medications where id=$1',[req.params.id])).rows[0];
  if(!entity)return reply.code(404).send({error:sourceOnly?'listing_not_found':'medication_not_found'});
  const identityColumn=sourceOnly?'l.id':'l.medication_id',matchingScope=sourceOnly?'source_listing_only':'reviewed_medication';
  const asOf=new Date().toISOString(),limit=query.limit??50;
  const values=[asOf,req.params.id,q,query.unit??null,query.source??null,query.location??null,query.program??null];
  const joins=`from pricing.offers o join pricing.listings l on l.id=o.listing_id join pricing.sources s on s.id=l.source_id where ${identityColumn}=$2::bigint and ($5::text is null or s.slug=$5) and ($6::text is null or o.location_key=$6) and ($7::text is null or o.program_key=$7)`;
  const exact=`($3::numeric is null or (o.quantity*l.content_quantity=$3::numeric and l.content_unit=$4))`;
  const {rows}=await pool.query(`select o.id as offer_id,l.id as listing_id,s.slug as source,l.source_name,l.brand_name,l.match_status,case when l.match_status='verified' then l.medication_id end as medication_id,l.sold_as,l.content_quantity,l.content_unit,l.url as purchase_url,
   o.quantity as ordering_quantity,o.quantity*l.content_quantity as physical_quantity,o.price_cents,o.currency,o.availability,(o.availability='unknown') as purchase_verification_required,o.seller_key,o.location_key,o.program_key,
   o.last_checked_at as observed_at,least(o.last_checked_at+interval '24 hours',coalesce(o.valid_until,'infinity'::timestamptz)) as fresh_until,
   coalesce(o.terms->>'quote_kind','source_product_total') as quote_kind,o.terms as quote_terms
   ${joins} and ${eligible(includeEstimates,sourceOnly)} and ${exact} and o.id>$8::bigint order by o.id limit $9`,[...values,query.cursor??'0',limit+1]);
  const exclusions=(await pool.query(`select source,reason,count(*)::int as offers from(select s.slug as source,case
   when not s.enabled then 'source_disabled' ${sourceOnly?"when l.match_status='needs_review' then 'identity_quarantined' when l.content_quantity is null or l.content_unit is null then 'packaging_unresolved'":"when l.match_status<>'verified' or l.content_quantity is null or l.content_unit is null then 'not_verified'"}
   when not ${exact} then null when not o.active then 'retired' when not ${availabilityRule(includeEstimates)} then o.availability when o.price_cents is null then 'missing_price'
   when o.last_checked_at<$1::timestamptz-interval '24 hours' or o.valid_until<=$1::timestamptz then 'stale_or_expired'
   else null end as reason ${joins}) x where reason is not null group by source,reason order by source,reason`,values)).rows;
  const known=(await pool.query(`select s.slug,coalesce(bool_or($2::numeric is null or (o.quantity*l.content_quantity=$2::numeric and l.content_unit=$3)),false) as has_exact
   from pricing.listings l join pricing.sources s on s.id=l.source_id left join pricing.offers o on o.listing_id=l.id where ${identityColumn}=$1 group by s.slug`,[req.params.id,q,query.unit??null])).rows;
  for(const source of sourceOnly?[entity.source]:sourceValues)if(!query.source||query.source===source){const item=known.find(x=>x.slug===source);if(!item)exclusions.push({source,reason:'not_matched',offers:0});else if(q&&!item.has_exact)exclusions.push({source,reason:'unsupported_quantity',offers:0});}
  const more=rows.length>limit;
  return {as_of:asOf,...(sourceOnly?{listing:entity}:{medication:entity}),matching_scope:matchingScope,quote_scope:includeEstimates?'including_estimates':'eligible_only',requested_quantity:q,requested_unit:query.unit??null,items:rows.slice(0,limit).map(row=>({...row,matching_scope:matchingScope})),next_cursor:more?rows[limit-1].offer_id:null,
   quote_status:rows.length?(rows.slice(0,limit).some(x=>x.purchase_verification_required)?'includes_unconfirmed_estimates':'available'):q?'no_eligible_exact_quote':'no_eligible_offers',sources:await status(),exclusions};
 });
 }
 return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=makePool(true),app=buildApi(pool,process.env.HOUSEMED_API_TOKEN??'');
 const close=async()=>{await app.close();await pool.end();};process.once('SIGTERM',close);process.once('SIGINT',close);
 await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??63813)});
 console.log('HouseMed read API listening on configured loopback address.');
}
