// Mock pricing provider for the price-comparison UI.
// Cost Plus Drugs identity, product URLs and unit prices come from a snapshot of that pharmacy's
// public catalog API (mock/pricing-catalog.json). Walmart, Costco and Amazon figures are MODELLED
// from the same acquisition unit price using the supplier models below; they are not observed
// prices. Replace lookupComparison with repository queries once those sources are collected.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const SUPPLIERS=['walmart','costco','costplus','amazon'] as const;
export type SupplierSlug=typeof SUPPLIERS[number];
export const DAYS_SUPPLY=[30,90,365] as const;
export type DaysSupply=typeof DAYS_SUPPLY[number];

export interface CatalogStrength{strength:string;acquisition_unit_price_cents:number;costplus:{ndc:string;slug:string;product_url:string};}
export interface CatalogMedication{name:string;brand_name:string|null;form:string;route:string;doses_per_day:number;walmart_generics_program:boolean;strengths:CatalogStrength[];}
interface Catalog{snapshot_source:string;snapshot_taken_at:string;medications:CatalogMedication[];}

interface SupplierModel{
 slug:SupplierSlug;name:string;fulfilment:string;note:string;
 unit_price_factor:number;                       // retail cash price per unit ÷ acquisition unit price
 markup:number;                                  // percentage markup the pharmacy states publicly
 dispensing_fee_cents:number;shipping_cents:number;minimum_price_cents:number;
 tier_unit_discount:Record<DaysSupply,number>;   // per-unit discount for larger day supplies
 max_days_per_fill:number;
 /** What the purchase link opens, so the UI can say so rather than implying a product page. */
 linkTarget(medication:CatalogMedication):string;
 productUrl(medication:CatalogMedication,strength:CatalogStrength):string;
}

// Link destinations verified in a real Chrome session on 2026-09-08. Costco's drug-directory search
// URL redirects to their home page once warehouse cookies are set, so the Member Prescription Program
// page is used instead. Walmart publishes no per-drug cash price page at all, so program drugs link to
// the $4/$10 program page that documents the quoted price and everything else to the pharmacy page.
const drug=(m:CatalogMedication)=>m.name.toLowerCase();
const WALMART_PROGRAM_PAGE='https://www.walmart.com/cp/4-prescriptions/1078664';
const WALMART_PHARMACY_PAGE='https://www.walmart.com/cp/pharmacy/5431';
export const models:Record<SupplierSlug,SupplierModel>={
 walmart:{slug:'walmart',name:'Walmart Pharmacy',fulfilment:'Store pickup',note:'$4/$10 generic program price where the drug is on the list.',
  unit_price_factor:11,markup:1,dispensing_fee_cents:0,shipping_cents:0,minimum_price_cents:400,
  tier_unit_discount:{30:1,90:0.95,365:0.9},max_days_per_fill:90,
  linkTarget:m=>m.walmart_generics_program?'Walmart $4/$10 program page':'Walmart pharmacy page',
  productUrl:m=>m.walmart_generics_program?WALMART_PROGRAM_PAGE:WALMART_PHARMACY_PAGE},
 costco:{slug:'costco',name:'Costco Pharmacy',fulfilment:'Store pickup or mail order',note:'Member cash price; a membership is not required to use the pharmacy.',
  unit_price_factor:7,markup:1,dispensing_fee_cents:0,shipping_cents:0,minimum_price_cents:299,
  tier_unit_discount:{30:1,90:0.95,365:0.9},max_days_per_fill:90,
  linkTarget:()=>'Costco Member Prescription Program page for this drug',
  productUrl:m=>`https://www.costco.com/cmpps?drugNameParam=${encodeURIComponent(m.name)}`},
 costplus:{slug:'costplus',name:'Cost Plus Drugs',fulfilment:'Mail order',note:'Acquisition cost plus 15%, a $5 pharmacy fee and $5.25 shipping per fill.',
  unit_price_factor:1,markup:1.15,dispensing_fee_cents:500,shipping_cents:525,minimum_price_cents:0,
  tier_unit_discount:{30:1,90:1,365:1},max_days_per_fill:90,
  linkTarget:()=>'Cost Plus product page',
  productUrl:(_m,s)=>s.costplus.product_url},
 amazon:{slug:'amazon',name:'Amazon Pharmacy',fulfilment:'Mail order',note:'Modelled cash price. Amazon\'s list price without insurance runs far higher; Prime and RxPass discounts run lower.',
  unit_price_factor:8.5,markup:1,dispensing_fee_cents:0,shipping_cents:0,minimum_price_cents:500,
  tier_unit_discount:{30:1,90:0.95,365:0.9},max_days_per_fill:90,
  linkTarget:()=>'Amazon Pharmacy listings',
  productUrl:m=>`https://pharmacy.amazon.com/s?k=${encodeURIComponent(drug(m))}`},
};
// Walmart's published generic program: 30-day and 90-day flat prices, refilled quarterly for a year.
const walmartProgram:Record<DaysSupply,number>={30:400,90:1000,365:4000};

export interface Quote{
 days_supply:DaysSupply;quantity:number;unit:string;fills:number;
 price_cents:number;unit_price_cents:number;price_per_day_cents:number;currency:'USD';
 availability:'in_stock';quote_kind:'estimate'|'catalog_estimate';pricing_basis:string;purchase_url:string;
}
export interface SupplierQuotes{source:SupplierSlug;source_name:string;fulfilment:string;note:string;link_target:string;product_url:string;quotes:Quote[];}
export interface Comparison{
 as_of:string;data_source:'mock';query:{medication:string;strength:string|null};
 medication:{name:string;brand_name:string|null;strength:string;form:string;route:string;doses_per_day:number};
 available_strengths:string[];days_supply_options:number[];
 suppliers:SupplierQuotes[];
 /** Cheapest supplier for each day supply, keyed by days. */
 best_by_days_supply:Record<string,{source:SupplierSlug;price_cents:number;purchase_url:string}>;
 /** Lowest cost per day across every supplier and tier. */
 best_value:{source:SupplierSlug;days_supply:DaysSupply;price_cents:number;price_per_day_cents:number;purchase_url:string}|null;
}

const catalogPath=fileURLToPath(new URL('../mock/pricing-catalog.json',import.meta.url));
let cached:Catalog|null=null;
export function catalog():Catalog{return cached??=JSON.parse(readFileSync(catalogPath,'utf8')) as Catalog;}

const normalize=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const unitFor=(form:string)=>form.toLowerCase()==='capsule'?'capsule':'tablet';

/** Medications whose name or brand name matches the search text, best match first. */
export function searchMedications(text:string,limit=8):CatalogMedication[]{
 const q=normalize(text);if(!q)return [];
 const scored=catalog().medications.map(m=>{
  const name=normalize(m.name),brand=normalize(m.brand_name??'');
  const score=name===q?0:name.startsWith(q)?1:brand===q?2:brand.startsWith(q)?3:name.includes(q)?4:brand.includes(q)?5:-1;
  return {m,score};
 }).filter(x=>x.score>=0).sort((a,b)=>a.score-b.score||a.m.name.localeCompare(b.m.name));
 return scored.slice(0,limit).map(x=>x.m);
}

function priceFor(model:SupplierModel,medication:CatalogMedication,strength:CatalogStrength,days:DaysSupply,quantity:number,fills:number):{price_cents:number;pricing_basis:string}{
 const unit=strength.acquisition_unit_price_cents*model.unit_price_factor*model.markup*model.tier_unit_discount[days];
 const fees=(model.dispensing_fee_cents+model.shipping_cents)*fills;
 const modelled=Math.max(Math.round(unit*quantity+fees),model.minimum_price_cents);
 const drugs=Math.round(unit*quantity);
 const basis=fees>0?`${money(drugs)} medication + ${money(fees)} pharmacy and shipping fees across ${fills} fill${fills===1?'':'s'}`
  :`${money(modelled)} cash price for ${quantity} ${unitFor(medication.form)}s`;
 if(model.slug==='walmart'&&medication.walmart_generics_program){
  const program=walmartProgram[days];
  if(program<=modelled)return {price_cents:program,pricing_basis:`$4/$10 generic program: ${money(walmartProgram[days===365?90:days])} per ${days===365?90:days}-day fill × ${fills}`};
 }
 return {price_cents:modelled,pricing_basis:basis};
}
const money=(cents:number)=>`$${(cents/100).toFixed(2)}`;

export interface ComparisonRequest{medication:string;strength?:string|null;}
/** Build the full four-supplier, three-tier comparison for one medication strength. */
export function lookupComparison(request:ComparisonRequest):Comparison|null{
 const medication=searchMedications(request.medication,1)[0];
 if(!medication)return null;
 const wanted=request.strength?normalize(request.strength):null;
 const strength=(wanted?medication.strengths.find(s=>normalize(s.strength)===wanted):undefined)??medication.strengths[0];
 if(!strength)return null;
 const unit=unitFor(medication.form);
 const suppliers:SupplierQuotes[]=SUPPLIERS.map(slug=>{
  const model=models[slug],productUrl=model.productUrl(medication,strength);
  const quotes=DAYS_SUPPLY.map(days=>{
   const quantity=medication.doses_per_day*days,fills=Math.max(1,Math.round(days/model.max_days_per_fill));
   const {price_cents,pricing_basis}=priceFor(model,medication,strength,days,quantity,fills);
   return {days_supply:days,quantity,unit,fills,price_cents,
    unit_price_cents:Math.round((price_cents/quantity)*100)/100,
    price_per_day_cents:Math.round((price_cents/days)*100)/100,
    currency:'USD' as const,availability:'in_stock' as const,
    quote_kind:slug==='costplus'?'catalog_estimate' as const:'estimate' as const,
    pricing_basis,purchase_url:productUrl};
  });
  return {source:slug,source_name:model.name,fulfilment:model.fulfilment,note:model.note,link_target:model.linkTarget(medication),product_url:productUrl,quotes};
 });
 const flat=suppliers.flatMap(s=>s.quotes.map(q=>({source:s.source,quote:q})));
 const cheapestPerDay=flat.reduce((best,x)=>x.quote.price_per_day_cents<best.quote.price_per_day_cents?x:best,flat[0]);
 const bestByDays=Object.fromEntries(DAYS_SUPPLY.map(days=>{
  const winner=flat.filter(x=>x.quote.days_supply===days).reduce((best,x)=>x.quote.price_cents<best.quote.price_cents?x:best);
  return [String(days),{source:winner.source,price_cents:winner.quote.price_cents,purchase_url:winner.quote.purchase_url}];
 }));
 return {
  as_of:new Date().toISOString(),data_source:'mock',
  query:{medication:request.medication,strength:request.strength??null},
  medication:{name:medication.name,brand_name:medication.brand_name,strength:strength.strength,form:medication.form,route:medication.route,doses_per_day:medication.doses_per_day},
  available_strengths:medication.strengths.map(s=>s.strength),days_supply_options:[...DAYS_SUPPLY],
  suppliers,best_by_days_supply:bestByDays,
  best_value:cheapestPerDay?{source:cheapestPerDay.source,days_supply:cheapestPerDay.quote.days_supply,price_cents:cheapestPerDay.quote.price_cents,price_per_day_cents:cheapestPerDay.quote.price_per_day_cents,purchase_url:cheapestPerDay.quote.purchase_url}:null,
 };
}
