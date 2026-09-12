import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Listing} from './core.js';

export interface TopMedicationCatalog {
 entries:string[];
 keys:Set<string>;
 includes(listing:Listing):boolean;
}

const dosageWords=/\b(?:\d+(?:\.\d+)?|mg|mcg|g|gm|ml|iu|%|tablet|tablets|tab|tabs|capsule|capsules|cap|caps|cream|solution|oral|topical|injection|inhaler|suspension|extended|immediate|release|xr|er|dr)\b/g;
function words(value:string){
 return value.toLowerCase().replace(/&/g,';').replace(/%/g,' ').replace(/[^a-z0-9;.\s-]/g,' ').replace(dosageWords,' ').replace(/\s+/g,' ').trim();
}
export function medicationKey(value:string){
 return value.split(';').map(part=>words(part)).filter(Boolean).sort().join(';');
}
function sourceWords(value:string){
 return words(value.replace(/[-/]/g,' '));
}
function parseTopMedications(text:string){
 return text.split(/\n/).map(line=>line.match(/^\s*\d{3}\.\s+(.+?)\s*$/)?.[1]).filter((x):x is string=>Boolean(x));
}
export async function loadTopMedicationCatalog(path=resolve(process.cwd(),'../top-200-us-prescription-medications.txt')):Promise<TopMedicationCatalog>{
 const entries=parseTopMedications(await readFile(path,'utf8'));
 if(entries.length!==200)throw Error('TOP_MEDICATION_LIST_INVALID');
 const keys=new Set(entries.map(medicationKey).filter(Boolean));
 return {
  entries,keys,
  includes(listing){
   if(listing.medication&&keys.has(medicationKey(listing.medication.name)))return true;
   const label=sourceWords(listing.source_name);
   return entries.some(entry=>{
    const key=medicationKey(entry);if(!key)return false;
    const parts=key.split(';');
    return parts.every(part=>new RegExp(`(?:^| )${part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?: |$)`).test(label));
   });
  },
 };
}
