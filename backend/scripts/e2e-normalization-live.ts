import assert from 'node:assert/strict';
import {MedicationNormalizer,RxNormClient} from '../src/normalization.js';

const normalizer=new MedicationNormalizer(new RxNormClient());
const inputs=[
 {name:'Lisinopril',strength:'20mg',form:'Tablet',ndc:'68180098103'},
 {name:'LISINOPRIL',strength:'20 MG',form:'tablets'},
];
const decisions=[];
for(const input of inputs)decisions.push(await normalizer.normalize(input));
for(const decision of decisions){assert.equal(decision.status,'verified');assert.equal(decision.normalized?.rxnorm_rxcui,'314077');assert.equal(decision.normalized?.normalized_key,'rxnorm:314077');assert.equal(decision.normalized?.form,'tablet');assert.equal(decision.normalized?.strength,'20 mg');}
assert.equal(decisions[0].method,'ndc');assert.ok(['rxnorm_exact','rxnorm_normalized'].includes(decisions[1].method));
console.log(JSON.stringify({status:'passed',normalization_version:decisions[0].normalized?.normalization_version,terminology_version:decisions[0].terminology_version,checks:decisions.map((decision,index)=>({input:inputs[index],method:decision.method,rxcui:decision.normalized?.rxnorm_rxcui,canonical_name:decision.normalized?.canonical_name,normalized_key:decision.normalized?.normalized_key}))},null,2));
