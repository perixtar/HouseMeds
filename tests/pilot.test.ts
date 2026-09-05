import test from 'node:test';import assert from 'node:assert/strict';
import {validateManifest,manifestHash,collectionMetrics,resultForOffers,dailyWindow,reliabilityReport,DAY_MS,WINDOW_MS,type PilotManifest,type CollectionResult,type ReliabilityRun} from '../src/pilot.js';
import type {Quote} from '../src/core.js';
const first='2026-01-01T10:00:00.000Z',anchor=Date.parse(first);
function manifest():PilotManifest{return {inventory_audit_passed:true,listing_audit_passed:true,listings:(['healthwarehouse','costplus'] as const).flatMap((source,s)=>Array.from({length:100},(_,i)=>({source,page_id:String(s*100+i+1),source_product_key:'sku-'+i,url:source==='healthwarehouse'?`https://www.healthwarehouse.com/product-${i}`:`https://www.costplusdrugs.com/medications/product-${i}/`,planned_quantities:['30','60','90']}))) };}
function results(m:PilotManifest,source:string,count=100):Record<string,CollectionResult>{return Object.fromEntries(m.listings.filter(x=>x.source===source).slice(0,count).map(x=>[x.page_id,{successful:true,attempted_at:first,successful_quantities:[...x.planned_quantities!]}]));}
function runs(m:PilotManifest,days=7):ReliabilityRun[]{return Array.from({length:days},(_,i)=>['healthwarehouse','costplus'].map((source,j)=>({id:String(i*2+j+1),source,status:'succeeded',started_at:new Date(anchor+i*DAY_MS+1000).toISOString(),finished_at:new Date(anchor+i*DAY_MS+3600000).toISOString(),summary:{scope:'scheduled',window_start:new Date(anchor+i*DAY_MS).toISOString(),manifest_hash:manifestHash(m)},checkpoint:{collection_results:results(m,source)}} as ReliabilityRun))).flat();}
test('scheduled collection requires both audits, exactly 100 distinct products per source and frozen quantities',()=>{
 const m=manifest();assert.equal(validateManifest(m,false,true),m);
 const missingAudit=structuredClone(m);missingAudit.listing_audit_passed=false;assert.throws(()=>validateManifest(missingAudit,false,true),/LISTING_AUDIT_REQUIRED/);
 const duplicate=structuredClone(m);duplicate.listings[1].source_product_key=duplicate.listings[0].source_product_key;assert.throws(()=>validateManifest(duplicate,false,true),/DUPLICATE_MANIFEST_PRODUCT/);
 const changed=structuredClone(m);changed.listings[0].planned_quantities=['30','30.0'];assert.throws(()=>validateManifest(changed,false,true),/INVALID_PLANNED_QUANTITIES/);
 const absent=structuredClone(m);delete absent.listings[0].planned_quantities;assert.throws(()=>validateManifest(absent,false,true),/FROZEN_PRODUCT_AND_QUANTITIES_REQUIRED/);
 const short=structuredClone(m);short.listings.pop();assert.throws(()=>validateManifest(short,false,true),/EXPECTED_100_SOURCE_LISTINGS/);
});
test('unattempted quantities remain in fixed denominators and extra or duplicate observations cannot inflate success',()=>{
 const m=manifest(),items=m.listings.filter(x=>x.source==='healthwarehouse'),r=results(m,'healthwarehouse',95);r['999999']={successful:true,attempted_at:first,successful_quantities:['30','60','90']};r['1'].successful_quantities.push('30','1000');
 const metrics=collectionMetrics(items,r);assert.equal(metrics.planned_listings,100);assert.equal(metrics.planned_quantity_checks,300);assert.equal(metrics.successful_listings,95);assert.equal(metrics.successful_quantity_checks,285);assert.equal(metrics.quantity_success_rate,0.95);
});
test('known out-of-stock is a valid checked state while unknown availability is not',()=>{
 const item=manifest().listings[0];item.planned_quantities=['30'];const offer:Quote={quantity:'30',price_cents:null,currency:'USD',availability:'out_of_stock',seller_key:'healthwarehouse',location_key:'online-us',program_key:'cash',terms:{},active:true,valid_until:null};
 assert.equal(resultForOffers(item,[offer]).successful,true);offer.availability='unknown';assert.equal(resultForOffers(item,[offer]).successful,false);
});
test('daily windows use the same UTC anchor, stop after two hours, and do not make up missed days',()=>{
 assert.equal(dailyWindow(first,new Date(anchor-1)),null);assert.equal(dailyWindow(first,new Date(anchor+WINDOW_MS-1))!.open,true);
 assert.equal(dailyWindow(first,new Date(anchor+WINDOW_MS))!.open,false);assert.equal(dailyWindow(first,new Date(anchor+3*DAY_MS))!.index,3);
});
test('seven-day pass requires seven elapsed completed windows for both sources',()=>{
 const m=manifest(),r=runs(m);const before=reliabilityReport(m,first,r,new Date(anchor+6*DAY_MS+WINDOW_MS-1));assert.equal(before.seven_day_collection_passed,false);assert.equal(before.best_passing_streak,6);
 const done=reliabilityReport(m,first,r,new Date(anchor+6*DAY_MS+WINDOW_MS));assert.equal(done.seven_day_collection_passed,true);assert.equal(done.best_passing_streak,7);
 r.splice(5,1);const gap=reliabilityReport(m,first,r,new Date(anchor+6*DAY_MS+WINDOW_MS));assert.equal(gap.seven_day_collection_passed,false);assert.equal(gap.best_passing_streak,4);
});
test('access tests, changed cohorts, late runs and operator intervention cannot satisfy a daily window',()=>{
 const m=manifest();for(const defect of ['scope','hash','late','intervention']){
  const r=runs(m,1);if(defect==='scope')r[0].summary.scope='access_test';if(defect==='hash')r[0].summary.manifest_hash='different';if(defect==='late')r[0].finished_at=new Date(anchor+WINDOW_MS+1).toISOString();if(defect==='intervention')r[0].summary.operator_intervention=true;
  assert.equal(reliabilityReport(m,first,r,new Date(anchor+WINDOW_MS)).windows[0].status,'failed',defect);
 }
});
test('resumed runs use the final outcomes once; listing and quantity thresholds both must pass',()=>{
 const m=manifest(),r=runs(m,1);r[0].status='partial';r[0].checkpoint!.collection_results=results(m,'healthwarehouse',95);
 assert.equal(reliabilityReport(m,first,r,new Date(anchor+WINDOW_MS)).windows[0].status,'passed');
 const retry={...r[0],id:'3',started_at:new Date(anchor+3600001).toISOString(),finished_at:new Date(anchor+4000000).toISOString(),checkpoint:{collection_results:results(m,'healthwarehouse')}};
 const res=reliabilityReport(m,first,[...r,retry],new Date(anchor+WINDOW_MS));assert.equal(res.windows[0].sources[0].successful_listings,100);assert.equal(res.windows[0].sources[0].successful_quantity_checks,300);
 for(const result of Object.values(retry.checkpoint.collection_results))result.successful_quantities=['30'];
 assert.equal(reliabilityReport(m,first,[...r,retry],new Date(anchor+WINDOW_MS)).windows[0].status,'failed');
});

test('a late retry cannot hide behind an earlier passing result',()=>{
 const m=manifest(),r=runs(m,1);r.push({...r[0],id:'3',finished_at:new Date(anchor+WINDOW_MS+1).toISOString()});
 assert.equal(reliabilityReport(m,first,r,new Date(anchor+WINDOW_MS+2)).windows[0].status,'failed');
});
