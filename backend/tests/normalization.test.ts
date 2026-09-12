import test from 'node:test';
import assert from 'node:assert/strict';
import {FORM_CODES,MedicationNormalizer,QUANTITY_UNIT_CODES,STRENGTH_UNIT_CODES,normalizeForm,normalizeQuantityUnit,normalizeSearchText,parseStrength,type TerminologyResolver} from '../src/normalization.js';

const lisinopril:TerminologyResolver={resolve:async()=>({method:'rxnorm_normalized',version:'08-Sep-2026',concepts:[{rxcui:'314077',name:'lisinopril 20 MG Oral Tablet',tty:'SCD'}]})};

test('approved name, form and unit formatting is deterministic and idempotent',()=>{
 assert.equal(normalizeSearchText('  LISINOPRIL®  20MG Tabs  '),'lisinopril 20 mg tabs');
 assert.equal(normalizeSearchText(normalizeSearchText('  LISINOPRIL®  20MG Tabs  ')),normalizeSearchText('  LISINOPRIL®  20MG Tabs  '));
 assert.equal(normalizeForm('Extended Release Oral Tablets'),'tablet');
 assert.equal(normalizeQuantityUnit('ampoules'),'ampule');
 assert.equal(normalizeQuantityUnit('millilitres'),'ml');
});

test('every approved MVP form, strength unit and quantity unit is recognized',()=>{
 for(const form of FORM_CODES)assert.equal(normalizeForm(form),form);
 for(const unit of QUANTITY_UNIT_CODES)assert.equal(normalizeQuantityUnit(unit),unit);
 const examples:Record<typeof STRENGTH_UNIT_CODES[number],string>={mcg:'1 mcg',mg:'1 mg',g:'1 g',ml:'1 mg/mL',l:'1 mg/L',units:'1 units',iu:'1 IU',meq:'1 mEq',percent:'1%'};
 for(const unit of STRENGTH_UNIT_CODES)assert.ok(parseStrength(examples[unit]),unit);
});

test('strengths are exact, structured and preserve concentration denominators',()=>{
 assert.deepEqual(parseStrength('20MG'),{numerator_value:'20',numerator_unit:'mg',denominator_value:null,denominator_unit:null,display:'20 mg',key:'20:mg::'});
 assert.deepEqual(parseStrength('10 mg / mL'),{numerator_value:'10',numerator_unit:'mg',denominator_value:'1',denominator_unit:'ml',display:'10 mg/mL',key:'10:mg:1:ml'});
 assert.equal(parseStrength('100U/ml')?.display,'100 units/mL');
 assert.equal(parseStrength('0.4%')?.display,'0.4%');
 assert.equal(parseStrength('0 mg'),null);
 assert.equal(parseStrength('100-25 mg'),null,'ambiguous combination strength requires structured components');
 assert.equal(parseStrength('100 mg/25 mg'),null,'component strengths are not concentrations');
});

test('RxNorm-backed formatting variants converge on one verified identity',async()=>{
 const normalizer=new MedicationNormalizer(lisinopril);
 const first=await normalizer.normalize({name:'LISINOPRIL',strength:'20MG',form:'tabs',route:'oral',release_type:'IR'});
 const second=await normalizer.normalize({name:'lisinopril',strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate release'});
 assert.equal(first.status,'verified');assert.equal(second.status,'verified');
 assert.equal(first.normalized?.normalized_key,'rxnorm:314077');assert.equal(second.normalized?.normalized_key,'rxnorm:314077');
 assert.equal(first.normalized?.canonical_name,'lisinopril 20 MG Oral Tablet');
});

test('structured conflicts and approximate matches never auto-link',async()=>{
 const normalizer=new MedicationNormalizer(lisinopril);
 assert.equal((await normalizer.normalize({name:'lisinopril',strength:'10 mg',form:'tablet',route:'oral',release_type:'immediate'})).status,'unmatched');
 assert.equal((await normalizer.normalize({name:'lisinopril',strength:'20 mg',form:'capsule',route:'oral',release_type:'immediate'})).status,'unmatched');
 assert.equal((await normalizer.normalize({name:'lisinopril',strength:'20 mg',form:'tablet',route:'oral',release_type:'extended'})).status,'unmatched');
 const approximate=new MedicationNormalizer({resolve:async()=>({method:'rxnorm_approximate',version:'test',concepts:[{rxcui:'314077',name:'lisinopril 20 MG Oral Tablet',tty:'SCD'}]})});
 const candidate=await approximate.normalize({name:'lisinopril',strength:'20 mg',form:'tablet'});assert.equal(candidate.status,'needs_review');assert.equal(candidate.candidates[0].rxcui,'314077');
});

test('reviewed local identities normalize safely when terminology is unavailable',async()=>{
 const normalizer=new MedicationNormalizer();
 const a=await normalizer.normalize({name:'LISINOPRIL',strength:'20MG',form:'tablets',route:'oral',release_type:'IR'},{reviewed:true});
 const b=await normalizer.normalize({name:'lisinopril',strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate'},{reviewed:true});
 assert.equal(a.status,'verified');assert.equal(a.method,'reviewed_input');assert.equal(a.normalized?.normalized_key,b.normalized?.normalized_key);
 assert.equal((await normalizer.normalize({name:'insulin',strength:'10 mL',form:'solution',route:'subcutaneous',release_type:'not applicable'},{reviewed:true})).status,'needs_review');
});
