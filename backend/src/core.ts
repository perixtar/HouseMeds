import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';

export type SourceSlug = 'healthwarehouse'|'costplus';
export type Availability = 'in_stock'|'out_of_stock'|'unknown';
export type Json = Record<string,unknown>;
export interface Medication {name:string; strength:string; form:string; route:string; release_type:string;}
export interface MedicationIdentityCandidate {
 name:string;strength:string;form:string;route?:string|null;release_type?:string|null;
 brand_name?:string|null;ndc?:string|null;species?:string[];
}
export interface Listing {
 source_product_key:string; source_name:string; url:string; brand_name:string|null;
 sold_as:string; content_quantity:string|null; content_unit:string|null;
 medication?:Medication; identity_candidate?:MedicationIdentityCandidate; metadata:Json;
}
export interface Quote {
 quantity:string; price_cents:string|null; currency:'USD'; availability:Availability;
 seller_key:string; location_key:string; program_key:string; terms:Json;
 valid_until:string|null; active:boolean;
}
export interface Observation {listing:Listing; offers:Quote[]; observed_at:string; evidence_path:string; complete:boolean;}
export const sources = {
 healthwarehouse:{name:'HealthWarehouse',origin:'https://www.healthwarehouse.com',hosts:['www.healthwarehouse.com','healthwarehouse.com'],seeds:['/','/sitemap'],privatePaths:['/profile','/addresses','/patients','/payment','/orders','/prescriptions','/prescribers','/autoreorders','/login','/register','/cart','/checkout']},
 costplus:{name:'Cost Plus Drugs',origin:'https://www.costplusdrugs.com',hosts:['www.costplusdrugs.com','costplusdrugs.com'],seeds:['/','/medications/'],privatePaths:['/account','/cart','/health-profile','/prescription-confirmation','/prescription-manager','/callback','/chat','/optin','/create-account','/login','/sign-in','/sign-up','/checkout']},
} as const;
export const CP_API='https://us-central1-costplusdrugs-publicapi.cloudfunctions.net/main';
export function hash(value:string):string{return createHash('sha256').update(value).digest('hex');}
export function stable(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export function cents(value:unknown):string {
 const raw=String(value).replace(/^\$/,'').replaceAll(',','');
 if(!/^\d+(?:\.\d+)?$/.test(raw))throw Error('INVALID_MONEY');
 const amount=new Decimal(raw).times(100);
 if(!amount.isInteger()||amount.isNegative())throw Error('NON_CENT_TOTAL');
 return amount.toFixed(0);
}
export function quantity(value:unknown):string {
 const raw=String(value);if(!/^\d+(?:\.\d+)?$/.test(raw))throw Error('INVALID_QUANTITY');
 const n=new Decimal(raw);if(!n.isFinite()||!n.gt(0)||n.gt(1_000_000))throw Error('INVALID_QUANTITY');
 return n.toFixed();
}
export function offerKey(q:Quote):string {return stable([q.quantity,q.seller_key,q.location_key,q.program_key,q.currency]);}
export function normalizeUrl(href:string,base:string,source:SourceSlug):{url:string;reason:string|null}|null {
 let u:URL;try{u=new URL(href,base);}catch{return null;}
 const conf=sources[source];
 if(!['http:','https:'].includes(u.protocol)||!conf.hosts.some(x=>x===u.hostname)||u.username||u.password)return null;
 u.protocol='https:';u.hostname=new URL(conf.origin).hostname;u.hash='';u.port='';
 for(const k of [...u.searchParams.keys()])if(/^utm_|^(gclid|fbclid|msclkid)$/i.test(k)||(source==='healthwarehouse'&&k==='qty'&&u.searchParams.get(k)==='best'))u.searchParams.delete(k);
 const path=u.pathname.toLowerCase();
 let reason:string|null=null;
 if(conf.privatePaths.some(x=>path===x||path.startsWith(x+'/')))reason='private_or_transactional';
 else if(/\.(?:jpg|jpeg|png|webp|gif|svg|ico|css|js|map|woff2?|ttf|pdf|zip|mp4|mp3)$/i.test(path))reason='asset';
 else if(u.toString().length>1800)reason='url_length_requires_review';
 return {url:u.toString(),reason};
}
export function stock(value:unknown):Availability {
 const v=String(value);return /(?:OutOfStock|SoldOut|Discontinued)$/.test(v)?'out_of_stock':/InStock$/.test(v)?'in_stock':'unknown';
}
export function flattenJsonLd(value:unknown):Json[]{
 if(Array.isArray(value))return value.flatMap(flattenJsonLd);
 if(value&&typeof value==='object'){const obj=value as Json;return [obj,...flattenJsonLd(obj['@graph'])];}
 return [];
}
export function isProduct(obj:Json):boolean{return obj['@type']==='Product'||(Array.isArray(obj['@type'])&&obj['@type'].includes('Product'));}
export function assertObservation(o:Observation):void {
 if(!o.listing.source_product_key||!o.listing.source_name)throw Error('MISSING_IDENTITY');
 if(!Number.isFinite(Date.parse(o.observed_at)))throw Error('INVALID_OBSERVATION_TIME');
 const keys=new Set<string>();
 for(const q of o.offers){quantity(q.quantity);if(q.price_cents!==null&&!/^\d+$/.test(q.price_cents))throw Error('INVALID_CENTS');if(q.currency!=='USD')throw Error('INVALID_CURRENCY');if(q.availability==='in_stock'&&q.price_cents===null)throw Error('MISSING_PRICE');const key=offerKey(q);if(keys.has(key))throw Error('DUPLICATE_QUANTITY_CONTEXT');keys.add(key);}
}
