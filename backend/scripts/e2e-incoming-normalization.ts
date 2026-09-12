import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {Repository} from '../src/repository.js';
import {MedicationNormalizer,type TerminologyResolver} from '../src/normalization.js';
import {buildApi} from '../src/api.js';
import type {Observation} from '../src/core.js';
import {PricingApiAdapter} from '../../MedAPI/src/adapters/pricing/pricing-api.adapter.js';
import {makeAddPrescription} from '../../MedAPI/src/usecases/add-prescription.usecase.js';

const host=resolve('.cache/pgsock'),port=65431,dbName=`housemed_normalization_e2e_${process.pid}`;
const bootstrap=new pg.Pool({host,port,database:'postgres',max:1});let admin:pg.Pool|undefined,worker:pg.Pool|undefined,reader:pg.Pool|undefined,api:ReturnType<typeof buildApi>|undefined;
try{
 const dataDirectory=(await bootstrap.query('show data_directory')).rows[0].data_directory;assert.equal(resolve(dataDirectory),resolve('.cache/pg-test'),'Refuse E2E work outside the isolated test cluster');
 for(const role of ['housemed_worker','housemed_reader','housemed_backfill','anon','authenticated','service_role'])if(!(await bootstrap.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await bootstrap.query(`create role ${role}`);
 await bootstrap.query(`create database ${dbName}`);admin=new pg.Pool({host,port,database:dbName,max:1});
 for(const filename of (await readdir('supabase/migrations')).filter(x=>x.endsWith('.sql')).sort()){const sql=(await readFile('supabase/migrations/'+filename,'utf8')).replace(/create role housemed_\w+ nologin;/g,'');await admin.query(sql);}
 await admin.query('alter role housemed_worker login; alter role housemed_reader login');worker=new pg.Pool({host,port,database:dbName,user:'housemed_worker',max:2});reader=new pg.Pool({host,port,database:dbName,user:'housemed_reader',max:2});
 const terminology:TerminologyResolver={resolve:async()=>({method:'rxnorm_normalized',version:'08-Sep-2026',concepts:[{rxcui:'314077',name:'lisinopril 20 MG Oral Tablet',tty:'SCD'}]})};const repository=new Repository(worker,new MedicationNormalizer(terminology));
 const sourceIds=Object.fromEntries((await worker.query('select id,slug from pricing.sources')).rows.map(row=>[row.slug,row.id]));
 const observation=(source:'healthwarehouse'|'costplus',name:string,strength:string,form:string,price:string):Observation=>({listing:{source_product_key:'incoming-'+source,source_name:`${name} ${strength} ${form}`,url:`https://www.${source==='healthwarehouse'?'healthwarehouse.com':'costplusdrugs.com'}/incoming-e2e`,brand_name:null,sold_as:form,content_quantity:'1',content_unit:form,identity_candidate:{name,strength,form,route:'oral',release_type:'immediate',brand_name:null,ndc:source==='costplus'?'68180098103':null,species:[]},metadata:{}},offers:[{quantity:'90',price_cents:price,currency:'USD',availability:'in_stock',seller_key:source,location_key:'online-us',program_key:'cash',terms:{quote_kind:'source_product_total'},valid_until:null,active:true}],observed_at:new Date().toISOString(),evidence_path:`local://incoming-e2e-${source}.json`,complete:true});
 for(const [source,item] of Object.entries({healthwarehouse:observation('healthwarehouse','LISINOPRIL','20MG','tablets','1260'),costplus:observation('costplus','lisinopril','20 mg','tablet','666')})){const run=(await worker.query("insert into pricing.crawl_runs(source_id,parser_version) values($1,'normalization-e2e') returning id",[sourceIds[source]])).rows[0].id;await repository.saveObservation(sourceIds[source],run,item);await worker.query("update pricing.crawl_runs set status='succeeded',finished_at=now() where id=$1",[run]);}
 const medications=(await worker.query("select * from pricing.medications where rxnorm_rxcui='314077'")).rows;assert.equal(medications.length,1);const medicationId=medications[0].id;
 const listings=(await worker.query("select medication_id,match_status from pricing.listings where source_product_key like 'incoming-%'")).rows;assert.equal(listings.length,2);assert.ok(listings.every(row=>row.medication_id===medicationId&&row.match_status==='verified'));
 const token='normalization-e2e-api-token-at-least-32-chars';api=buildApi(reader,token);const origin=await api.listen({host:'127.0.0.1',port:0});
 let persisted:any=null,enqueued:any=null;const prescriptionRepository={create:async(value:any)=>persisted={id:'normalization-e2e-prescription',...value},findById:async()=>null,listByHousehold:async()=>[],replace:async(value:any)=>value,softDelete:async()=>false,savePriceComparisons:async()=>{},markPriceComparisonUnavailable:async()=>{}};const jobQueue={enqueuePriceComparisonJob:async(value:any)=>{enqueued=value;}};
 const addPrescription=makeAddPrescription(prescriptionRepository,new PricingApiAdapter({baseUrl:origin,apiKey:token}),jobQueue);const household=await addPrescription({householdId:'normalization-e2e-household',members:[{nickname:'Test member',medicines:[{medicationId,quantity:90,quantityUnit:'tablet'}]}]});const medicine=household.members[0].medicines[0];
 assert.equal(medicine.medicationId,medicationId);assert.notEqual(medicine.id,medicine.medicationId);assert.equal(medicine.name,'lisinopril 20 MG Oral Tablet');assert.equal(medicine.strength,'20 mg');assert.equal(medicine.form,'tablet');assert.equal(medicine.quantityUnit,'tablet');assert.equal(medicine.unitPrice,0.074);assert.equal(medicine.total,6.66);assert.equal(household.totalPrice,6.66);assert.equal(persisted.id,'normalization-e2e-prescription');assert.equal(enqueued.prescriptionId,'normalization-e2e-prescription');
 console.log(JSON.stringify({status:'passed',rxnorm_rxcui:'314077',canonical_medication_id:medicationId,verified_pharmacy_listings:listings.length,medapi_line_id:medicine.id,requested_quantity:medicine.quantity,quantity_unit:medicine.quantityUnit,total:medicine.total},null,2));
}finally{
 await api?.close();await Promise.all([reader?.end(),worker?.end(),admin?.end()]);await bootstrap.query(`drop database if exists ${dbName} with(force)`);await bootstrap.end();
}
