import test from 'node:test';import assert from 'node:assert/strict';
import {loadTopMedicationCatalog,medicationKey} from '../src/top-medications.js';
import type {Listing} from '../src/core.js';

const listing=(source_name:string,name?:string):Listing=>({source_product_key:'fixture',source_name,url:'https://www.costco.com/drug-results-details-price?drugId=fixture',brand_name:null,sold_as:'tablet',content_quantity:'1',content_unit:'tablet',metadata:{},...(name?{medication:{name,strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate'}}:{})});

test('top medication keys ignore dose/form wording but preserve ingredient identity',()=>{
 assert.equal(medicationKey('Clobetasol 0.05% Cream'),medicationKey('clobetasol cream'));
 assert.equal(medicationKey('Acetaminophen; Hydrocodone'),medicationKey('Hydrocodone; Acetaminophen'));
});

test('top medication catalog matches canonical medication and source labels only when listed',async()=>{
 const catalog=await loadTopMedicationCatalog('../top-200-us-prescription-medications.txt');
 assert.equal(catalog.includes(listing('Costco Lisinopril 20 Mg Tab Solc','lisinopril')),true);
 assert.equal(catalog.includes(listing('Fluorouracil 2% Topical Solution')),true);
 assert.equal(catalog.includes(listing('Imaginaryazole 10 Mg Tab')),false);
 assert.equal(catalog.includes(listing('Imaginary product','quasarazole')),false);
});
