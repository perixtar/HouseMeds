import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {MedicationNormalizer,type TerminologyResolver} from '../src/normalization.js';
import {approveMedicationBackfill,applyMedicationBackfill,captureBackfillSnapshot,planMedicationBackfill,stageMedicationBackfill} from '../src/backfill.js';

const host=resolve('.cache/pgsock'),port=65431,database=`housemed_backfill_backup_e2e_${process.pid}`;
const bootstrap=new pg.Pool({host,port,database:'postgres',max:1});let admin:pg.Pool|undefined,worker:pg.Pool|undefined,created=false;
const evidencePath=resolve('data/evidence/backfill-backup-e2e.json');let backupPath:string|undefined,manifestPath:string|undefined;
try{
 const dataDirectory=(await bootstrap.query('show data_directory')).rows[0].data_directory;assert.equal(resolve(dataDirectory),resolve('.cache/pg-test'),'Refuse E2E work outside the isolated test cluster');
 for(const role of ['housemed_worker','housemed_reader','housemed_backfill','anon','authenticated','service_role'])if(!(await bootstrap.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await bootstrap.query(`create role ${role}`);
 await bootstrap.query(`create database ${database}`);created=true;admin=new pg.Pool({host,port,database,max:1});
 for(const filename of (await readdir('supabase/migrations')).filter(name=>name.endsWith('.sql')).sort())await admin.query((await readFile('supabase/migrations/'+filename,'utf8')).replace(/create role housemed_\w+ nologin;/g,''));
 await admin.query('alter role housemed_worker login; alter role housemed_reader login; alter role housemed_backfill login');worker=new pg.Pool({host,port,database,user:'housemed_worker',max:1});
 await mkdir(resolve('data/evidence'),{recursive:true});await writeFile(evidencePath,JSON.stringify({scope:'isolated-backfill-backup-e2e'})+'\n',{mode:0o600});
 const source=(await worker.query("select id from pricing.sources where slug='healthwarehouse'")).rows[0].id;
 const medication=(await worker.query("insert into pricing.medications(name,strength,form,route,release_type) values('backup-e2e-lisinopril','20MG','tablets','oral','IR') returning id")).rows[0].id;
 const listing=(await worker.query("insert into pricing.listings(source_id,source_product_key,medication_id,source_name,url,sold_as,content_quantity,content_unit,match_status,metadata) values($1,'backfill-backup-e2e',$2,'Backup E2E Lisinopril 20mg Tablets','https://example.test/backfill-backup-e2e','pack',1,'tablets','verified','{}') returning id",[source,medication])).rows[0].id;
 const crawlRun=(await worker.query("insert into pricing.crawl_runs(source_id,parser_version) values($1,'backfill-backup-e2e') returning id",[source])).rows[0].id;
 const offer=(await worker.query("insert into pricing.offers(listing_id,offer_key,quantity,seller_key,location_key,program_key,price_cents,currency,availability,terms,active,last_checked_at,crawl_run_id) values($1,'backfill-backup-e2e',90,'healthwarehouse','online-us','cash',666,'USD','in_stock','{}',true,now(),$2) returning id",[listing,crawlRun])).rows[0].id;
 await worker.query("insert into pricing.offer_history(offer_id,crawl_run_id,observed_at,price_cents,currency,availability,snapshot) values($1,$2,now(),666,'USD','in_stock',$3)",[offer,crawlRun,JSON.stringify({evidence_path:'local://backfill-backup-e2e.json'})]);await worker.query("update pricing.crawl_runs set status='succeeded',finished_at=now() where id=$1",[crawlRun]);
 const resolver:TerminologyResolver={resolve:async()=>({method:'rxnorm_normalized',version:'fixture-backup-v1',concepts:[{rxcui:'777314077',name:'backup e2e lisinopril 20 MG Oral Tablet',tty:'SCD'}]})};
 const backfillPool=new pg.Pool({host,port,database,user:'housemed_backfill',max:1});
 try{
  const normalizer=new MedicationNormalizer(resolver),plan=await planMedicationBackfill(backfillPool,normalizer);
  const staged=await stageMedicationBackfill(backfillPool,normalizer,{sha256:'b'.repeat(64),created_at:new Date().toISOString(),restore_verified:true,format:'housemed-logical-backup-v3',database_state_hash:plan.baseline.recovery_hash},'backup-e2e');
  const approval=await approveMedicationBackfill(backfillPool,staged.run_id,'backup-e2e');await applyMedicationBackfill(backfillPool,staged.run_id,'backup-e2e',approval.confirmation);
 }finally{await backfillPool.end();}
 const expectedRecoveryHash=(await captureBackfillSnapshot(worker)).recovery_hash;
 const connection=`postgresql://housemed_worker@localhost/${database}?host=${encodeURIComponent(host)}&port=${port}`;
 const child=spawnSync(process.execPath,['scripts/backup.mjs','--restore-test'],{cwd:resolve('.'),encoding:'utf8',timeout:30000,env:{...process.env,DATABASE_URL:connection,SUPABASE_SECRET_KEY:'',SUPABASE_PROJECT_REF:'local-backfill-e2e'}});
 assert.equal(child.status,0,child.stdout+child.stderr);const report=JSON.parse(child.stdout);backupPath=resolve(report.backup);manifestPath=resolve(report.file_manifest);
 assert.equal(report.restore_verified,true);assert.equal(report.database_state_hash,expectedRecoveryHash);assert.equal(report.rows.medication_backfill_runs,1);assert.equal(report.rows.medication_backfill_items,1);assert.equal(report.rows.medication_backfill_events,4);assert.equal(report.rows.medication_matches,1);assert.ok(report.http_api.checks.length>=3);
 console.log(JSON.stringify({status:'passed',backfill_run_rows:report.rows.medication_backfill_runs,backfill_item_rows:report.rows.medication_backfill_items,backfill_event_rows:report.rows.medication_backfill_events,match_evidence_rows:report.rows.medication_matches,restore_verified:report.restore_verified,restore_api_checks:report.http_api.checks.length},null,2));
}finally{
 try{await Promise.all([worker?.end(),admin?.end()]);if(created)await bootstrap.query(`drop database if exists ${database} with(force)`);}finally{
  await bootstrap.end().catch(()=>{});await Promise.all([rm(evidencePath,{force:true}),...(backupPath?[rm(backupPath,{force:true})]:[]),...(manifestPath?[rm(manifestPath,{force:true})]:[])]);
 }
}
