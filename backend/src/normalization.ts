import {createHash} from 'node:crypto';
import {Decimal} from 'decimal.js';
import {networkFetch} from './network.js';

export const NORMALIZATION_VERSION='1';
export const FORM_CODES=['tablet','capsule','liquid','cream','ointment','gel','solution','suspension','inhaler','spray','drops','patch','injection','suppository','powder','lozenge'] as const;
export const STRENGTH_UNIT_CODES=['mcg','mg','g','ml','l','units','iu','meq','percent'] as const;
export const QUANTITY_UNIT_CODES=['tablet','capsule','ml','g','patch','inhaler','vial','syringe','pen','ampule','suppository','lozenge','dose'] as const;
export type FormCode=typeof FORM_CODES[number];
export type StrengthUnitCode=typeof STRENGTH_UNIT_CODES[number];
export type QuantityUnitCode=typeof QUANTITY_UNIT_CODES[number];
export type RxNormTermType='SCD'|'SBD';
export type MatchStatus='verified'|'needs_review'|'unmatched';
export type MatchMethod='ndc'|'rxnorm_exact'|'rxnorm_normalized'|'rxnorm_approximate'|'reviewed_input'|'none';

export interface RawMedicationIdentity {
 name:string;strength:string;form:string;route?:string|null;release_type?:string|null;
 brand_name?:string|null;ndc?:string|null;species?:string[];
}
export interface StrengthValue {
 numerator_value:string;numerator_unit:StrengthUnitCode;
 denominator_value:string|null;denominator_unit:StrengthUnitCode|QuantityUnitCode|null;
 display:string;key:string;
}
export interface RxNormConcept {rxcui:string;name:string;tty:RxNormTermType;}
export interface TerminologyResult {method:Exclude<MatchMethod,'reviewed_input'|'none'>;version:string|null;concepts:RxNormConcept[];}
export interface TerminologyResolver {resolve(input:RawMedicationIdentity):Promise<TerminologyResult>;}
export interface CanonicalMedication {
 name:string;strength:string;form:FormCode;route:string;release_type:string;
 canonical_name:string;normalized_name:string;normalized_key:string;
 rxnorm_rxcui:string|null;rxnorm_term_type:RxNormTermType|null;
 normalization_version:string;terminology_version:string|null;
 components:Array<{sequence:number;ingredient_name:string;ingredient_rxcui:string|null;precise_ingredient_rxcui:string|null;numerator_value:string;numerator_unit:StrengthUnitCode;denominator_value:string|null;denominator_unit:StrengthUnitCode|QuantityUnitCode|null}>;
}
export interface NormalizationDecision {
 status:MatchStatus;method:MatchMethod;reason:string|null;input_hash:string;
 normalized:CanonicalMedication|null;candidates:RxNormConcept[];terminology_version:string|null;
}

const formAliases=new Map<string,FormCode>([
 ['tab','tablet'],['tabs','tablet'],['tablet','tablet'],['tablets','tablet'],['chewable tablet','tablet'],
 ['cap','capsule'],['caps','capsule'],['capsule','capsule'],['capsules','capsule'],
 ['liquid','liquid'],['cream','cream'],['ointment','ointment'],['gel','gel'],['solution','solution'],['suspension','suspension'],
 ['inhaler','inhaler'],['spray','spray'],['drop','drops'],['drops','drops'],['patch','patch'],['patches','patch'],
 ['injection','injection'],['injectable','injection'],['suppository','suppository'],['suppositories','suppository'],
 ['powder','powder'],['lozenge','lozenge'],['lozenges','lozenge']
]);
const quantityAliases=new Map<string,QuantityUnitCode>([
 ['tab','tablet'],['tabs','tablet'],['tablet','tablet'],['tablets','tablet'],
 ['cap','capsule'],['caps','capsule'],['capsule','capsule'],['capsules','capsule'],
 ['ml','ml'],['milliliter','ml'],['milliliters','ml'],['millilitre','ml'],['millilitres','ml'],
 ['g','g'],['gram','g'],['grams','g'],['patch','patch'],['patches','patch'],['inhaler','inhaler'],['inhalers','inhaler'],
 ['vial','vial'],['vials','vial'],['syringe','syringe'],['syringes','syringe'],['pen','pen'],['pens','pen'],
 ['ampule','ampule'],['ampules','ampule'],['ampoule','ampule'],['ampoules','ampule'],
 ['suppository','suppository'],['suppositories','suppository'],['lozenge','lozenge'],['lozenges','lozenge'],['dose','dose'],['doses','dose']
]);
const strengthAliases=new Map<string,StrengthUnitCode>([
 ['mcg','mcg'],['ug','mcg'],['μg','mcg'],['µg','mcg'],['microgram','mcg'],['micrograms','mcg'],
 ['mg','mg'],['milligram','mg'],['milligrams','mg'],['g','g'],['gram','g'],['grams','g'],
 ['ml','ml'],['milliliter','ml'],['milliliters','ml'],['millilitre','ml'],['millilitres','ml'],['l','l'],['liter','l'],['liters','l'],['litre','l'],['litres','l'],
 ['u','units'],['unit','units'],['units','units'],['iu','iu'],['international unit','iu'],['international units','iu'],
 ['meq','meq'],['milliequivalent','meq'],['milliequivalents','meq'],['%','percent'],['percent','percent']
]);
const routes=new Map<string,string>([
 ['oral','oral'],['by mouth','oral'],['topical','topical'],['ophthalmic','ophthalmic'],['otic','otic'],['nasal','nasal'],
 ['inhalation','inhalation'],['rectal','rectal'],['vaginal','vaginal'],['subcutaneous','subcutaneous'],
 ['intramuscular','intramuscular'],['intravenous','intravenous'],['transdermal','transdermal']
]);
const releases=new Map<string,string>([
 ['immediate','immediate'],['immediate release','immediate'],['ir','immediate'],['conventional','immediate'],
 ['extended','extended'],['extended release','extended'],['er','extended'],['xr','extended'],['xl','extended'],['sr','extended'],
 ['delayed','delayed'],['delayed release','delayed'],['dr','delayed'],['enteric coated','delayed'],['ec','delayed'],
 ['not applicable','not_applicable'],['na','not_applicable'],['n a','not_applicable']
]);

export function normalizeSearchText(value:string):string {
 return value.normalize('NFKC').replace(/[®™℠]/g,'').toLowerCase().replace(/([0-9])([a-zµμ%])/g,'$1 $2').replace(/([a-zµμ])([0-9])/g,'$1 $2').replace(/[^a-z0-9µμ%/]+/g,' ').replace(/\s*\/\s*/g,' / ').replace(/\s+/g,' ').trim();
}
function aliasKey(value:string){return normalizeSearchText(value).replaceAll('/',' ').replace(/\s+/g,' ').trim();}
export function normalizeForm(value:string):FormCode|null {
 const key=aliasKey(value),direct=formAliases.get(key);if(direct)return direct;
 for(const [alias,code] of [...formAliases].sort((a,b)=>b[0].length-a[0].length))if(new RegExp(`(?:^| )${alias.replace(' ','\\s+')}s?(?: |$)`).test(key))return code;
 return null;
}
export function normalizeQuantityUnit(value:string):QuantityUnitCode|null{return quantityAliases.get(aliasKey(value))??null;}
function normalizeStrengthUnit(value:string):StrengthUnitCode|null{return strengthAliases.get(aliasKey(value))??null;}
function exactDecimal(value:string):string {const number=new Decimal(value);if(!number.isFinite()||!number.gt(0))throw Error('INVALID_STRENGTH_VALUE');return number.toFixed();}
function unitDisplay(unit:StrengthUnitCode|QuantityUnitCode):string{return unit==='ml'?'mL':unit==='l'?'L':unit==='iu'?'IU':unit==='meq'?'mEq':unit==='percent'?'%':unit;}
export function parseStrength(value:string):StrengthValue|null {
 const normalized=value.normalize('NFKC').trim();
 const match=normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-zµμ%]+(?:\s+[A-Za-z]+)?)\s*(?:\/\s*(?:(\d+(?:\.\d+)?)\s*)?([A-Za-zµμ%]+(?:\s+[A-Za-z]+)?))?$/i);
 if(!match)return null;
 const numeratorUnit=normalizeStrengthUnit(match[2]);if(!numeratorUnit)return null;
 let numeratorValue:string;try{numeratorValue=exactDecimal(match[1]);}catch{return null;}
 let denominatorUnit:StrengthUnitCode|QuantityUnitCode|null=null,denominatorValue:string|null=null;
 if(match[4]){const strengthDenominator=normalizeStrengthUnit(match[4]);denominatorUnit=normalizeQuantityUnit(match[4])??(strengthDenominator==='l'?'l':null);if(!denominatorUnit)return null;try{denominatorValue=exactDecimal(match[3]??'1');}catch{return null;}}
 const display=numeratorValue+(numeratorUnit==='percent'?'':' ')+unitDisplay(numeratorUnit)+(denominatorUnit?'/'+(denominatorValue==='1'?'':denominatorValue+' ')+unitDisplay(denominatorUnit):'');
 return {numerator_value:numeratorValue,numerator_unit:numeratorUnit,denominator_value:denominatorValue,denominator_unit:denominatorUnit,display,key:[numeratorValue,numeratorUnit,denominatorValue,denominatorUnit].join(':')};
}
function normalizeRoute(value:string|null|undefined):string|null{return value?routes.get(aliasKey(value))??null:null;}
function normalizeRelease(value:string|null|undefined):string|null{return value?releases.get(aliasKey(value))??null:null;}
function title(value:string):string{return value.split(' ').map(x=>x?x[0].toUpperCase()+x.slice(1):x).join(' ');}
function inferredRoute(conceptName:string,form:FormCode):string|null {
 const text=normalizeSearchText(conceptName);for(const route of routes.values())if(text.includes(route))return route;
 return ['tablet','capsule','lozenge'].includes(form)?'oral':form==='patch'?'transdermal':null;
}
function inferredRelease(conceptName:string,form:FormCode):string {
 const text=normalizeSearchText(conceptName);if(/\b(extended release|er|xr|xl|sr)\b/.test(text))return 'extended';if(/\b(delayed release|dr|enteric coated|ec)\b/.test(text))return 'delayed';
 return ['tablet','capsule','lozenge'].includes(form)?'immediate':'not_applicable';
}
function tokenSet(value:string):Set<string>{return new Set(normalizeSearchText(value).split(' ').filter(x=>x&&x!=='/'));}
function compatible(input:RawMedicationIdentity,strength:StrengthValue,form:FormCode,concept:RxNormConcept):boolean {
 const conceptTokens=tokenSet(concept.name),nameTokens=tokenSet(input.name);if(![...nameTokens].every(x=>conceptTokens.has(x)))return false;
 const strengthTokens=tokenSet(strength.display);if(![...strengthTokens].every(x=>conceptTokens.has(x)))return false;
 if(normalizeForm(concept.name)!==form)return false;
 const route=normalizeRoute(input.route);if(input.route&&(!route||!conceptTokens.has(route)))return false;
 const release=normalizeRelease(input.release_type),actual=inferredRelease(concept.name,form);if(input.release_type&&(!release||release!==actual))return false;
 if(input.brand_name){if(concept.tty!=='SBD'||![...tokenSet(input.brand_name)].every(x=>conceptTokens.has(x)))return false;}else if(concept.tty!=='SCD')return false;
 return true;
}
function inputHash(input:RawMedicationIdentity):string{return createHash('sha256').update(JSON.stringify({name:input.name,strength:input.strength,form:input.form,route:input.route??null,release_type:input.release_type??null,brand_name:input.brand_name??null,ndc:input.ndc??null,species:input.species??[]})).digest('hex');}
function fallbackDecision(input:RawMedicationIdentity,reviewed:boolean,reason:string):NormalizationDecision {
 const hash=inputHash(input),strength=parseStrength(input.strength),form=normalizeForm(input.form),route=normalizeRoute(input.route),release=normalizeRelease(input.release_type);
 if(!reviewed||!normalizeSearchText(input.name)||!strength||!form||!route||!release||strength.numerator_unit==='ml'||strength.numerator_unit==='l')return {status:reviewed?'needs_review':'unmatched',method:'none',reason,candidates:[],normalized:null,input_hash:hash,terminology_version:null};
 const normalizedName=normalizeSearchText(input.name),normalizedKey='local:'+createHash('sha256').update([normalizedName,strength.key,form,route,release,normalizeSearchText(input.brand_name??''),...(input.species??[]).sort()].join('|')).digest('hex');
 const canonicalName=[title(normalizedName),strength.display,title(route),release==='immediate'||release==='not_applicable'?'':title(release)+' Release',title(form)].filter(Boolean).join(' ');
 return {status:'verified',method:'reviewed_input',reason,candidates:[],input_hash:hash,terminology_version:null,normalized:{name:normalizedName,strength:strength.display,form,route,release_type:release,canonical_name:canonicalName,normalized_name:normalizedName,normalized_key:normalizedKey,rxnorm_rxcui:null,rxnorm_term_type:null,normalization_version:NORMALIZATION_VERSION,terminology_version:null,components:[{sequence:1,ingredient_name:normalizedName,ingredient_rxcui:null,precise_ingredient_rxcui:null,numerator_value:strength.numerator_value,numerator_unit:strength.numerator_unit,denominator_value:strength.denominator_value,denominator_unit:strength.denominator_unit}]}};
}

export class MedicationNormalizer {
 constructor(private readonly resolver?:TerminologyResolver){}
 async normalize(input:RawMedicationIdentity,options:{reviewed:boolean}={reviewed:false}):Promise<NormalizationDecision>{
  const hash=inputHash(input),strength=parseStrength(input.strength),form=normalizeForm(input.form);
  if(!normalizeSearchText(input.name))return fallbackDecision(input,options.reviewed,'missing_name');
  if(!strength)return fallbackDecision(input,options.reviewed,'unsupported_or_ambiguous_strength');
  if(strength.numerator_unit==='ml'||strength.numerator_unit==='l')return fallbackDecision(input,options.reviewed,'volume_without_concentration');
  if(!form)return fallbackDecision(input,options.reviewed,'unsupported_form');
  if(input.route&&!normalizeRoute(input.route))return fallbackDecision(input,options.reviewed,'unsupported_route');
  if(input.release_type&&!normalizeRelease(input.release_type))return fallbackDecision(input,options.reviewed,'unsupported_release_type');
  if(input.species?.length&&!options.reviewed)return {status:'needs_review',method:'none',reason:'species_requires_review',candidates:[],normalized:null,input_hash:hash,terminology_version:null};
  if(!this.resolver)return fallbackDecision(input,options.reviewed,'terminology_resolver_unavailable');
  let result:TerminologyResult;try{result=await this.resolver.resolve(input);}catch{return fallbackDecision(input,options.reviewed,'terminology_resolver_unavailable');}
  const compatibleConcepts=result.concepts.filter(x=>compatible(input,strength,form,x));
  if(result.method==='rxnorm_approximate')return {status:'needs_review',method:result.method,reason:'approximate_match_requires_review',candidates:result.concepts,input_hash:hash,normalized:null,terminology_version:result.version};
  if(compatibleConcepts.length!==1){if(options.reviewed&&result.concepts.length===0)return fallbackDecision(input,true,'reviewed_input_without_rxnorm_match');return {status:compatibleConcepts.length?'needs_review':'unmatched',method:result.method,reason:compatibleConcepts.length?'multiple_compatible_concepts':'no_compatible_concept',candidates:result.concepts,input_hash:hash,normalized:null,terminology_version:result.version};}
  const concept=compatibleConcepts[0],normalizedName=normalizeSearchText(input.name),route=normalizeRoute(input.route)??inferredRoute(concept.name,form),release=normalizeRelease(input.release_type)??inferredRelease(concept.name,form);
  if(!route||!release)return {status:'needs_review',method:result.method,reason:'route_or_release_unresolved',candidates:compatibleConcepts,input_hash:hash,normalized:null,terminology_version:result.version};
  const normalized:CanonicalMedication={name:normalizedName,strength:strength.display,form,route,release_type:release,canonical_name:concept.name,normalized_name:normalizedName,normalized_key:'rxnorm:'+concept.rxcui,rxnorm_rxcui:concept.rxcui,rxnorm_term_type:concept.tty,normalization_version:NORMALIZATION_VERSION,terminology_version:result.version,components:[{sequence:1,ingredient_name:normalizedName,ingredient_rxcui:null,precise_ingredient_rxcui:null,numerator_value:strength.numerator_value,numerator_unit:strength.numerator_unit,denominator_value:strength.denominator_value,denominator_unit:strength.denominator_unit}]};
  return {status:'verified',method:result.method,reason:null,candidates:compatibleConcepts,input_hash:hash,normalized,terminology_version:result.version};
 }
}

type IdResponse={idGroup?:{rxnormId?:string[]}};
type PropertiesResponse={properties?:{rxcui?:string;name?:string;tty?:string;suppress?:string}};
export class RxNormClient implements TerminologyResolver {
 private readonly cache=new Map<string,Promise<TerminologyResult>>();private versionPromise?:Promise<string|null>;
 constructor(private readonly origin='https://rxnav.nlm.nih.gov',private readonly timeoutMs=8000){}
 resolve(input:RawMedicationIdentity):Promise<TerminologyResult>{const key=inputHash(input);let found=this.cache.get(key);if(!found){found=this.resolveUncached(input).catch(error=>{this.cache.delete(key);throw error;});this.cache.set(key,found);}return found;}
 private async json<T>(path:string,params:Record<string,string>={}):Promise<T>{const url=new URL(path,this.origin);for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);const response=await networkFetch(url,{redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});if(!response.ok)throw Error('RXNORM_HTTP_'+response.status);return response.json() as Promise<T>;}
 private version():Promise<string|null>{return this.versionPromise??=this.json<{version?:string}>('/REST/version.json').then(x=>x.version??null).catch(error=>{this.versionPromise=undefined;throw error;});}
 private async concepts(ids:string[]):Promise<RxNormConcept[]>{const unique=[...new Set(ids)].filter(x=>/^\d+$/.test(x));const values=await Promise.all(unique.map(id=>this.json<PropertiesResponse>(`/REST/rxcui/${id}/properties.json`)));return values.flatMap(x=>{const p=x.properties;return p?.rxcui&&p.name&&(p.tty==='SCD'||p.tty==='SBD')&&p.suppress==='N'?[{rxcui:p.rxcui,name:p.name,tty:p.tty} as RxNormConcept]:[];});}
 private async ids(params:Record<string,string>):Promise<string[]>{return (await this.json<IdResponse>('/REST/rxcui.json',params)).idGroup?.rxnormId??[];}
 private async resolveUncached(input:RawMedicationIdentity):Promise<TerminologyResult>{
  const version=await this.version();
  if(input.ndc&&/^\d{10,11}$/.test(input.ndc)){const concepts=await this.concepts(await this.ids({idtype:'NDC',id:input.ndc,allsrc:'0'}));if(concepts.length)return {method:'ndc',version,concepts};}
  const query=[input.name,input.strength,input.route,input.release_type,input.form,input.brand_name].filter(Boolean).join(' ');
  const exact=await this.concepts(await this.ids({name:query,search:'0',allsrc:'0'}));if(exact.length)return {method:'rxnorm_exact',version,concepts:exact};
  const normalized=await this.concepts(await this.ids({name:query,search:'2',allsrc:'0'}));if(normalized.length)return {method:'rxnorm_normalized',version,concepts:normalized};
  const approximate=await this.concepts(await this.ids({name:query,search:'9',allsrc:'0'}));return {method:'rxnorm_approximate',version,concepts:approximate};
 }
}
