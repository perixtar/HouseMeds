import pg from 'pg';
import {existsSync,readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {DatabaseSocket} from '../src/network.js';
import {MedicationNormalizer,RxNormClient} from '../src/normalization.js';
import {
 approveMedicationBackfill,
 applyMedicationBackfill,
 backfillConfirmation,
 compensateMedicationBackfill,
 getMedicationBackfillStatus,
 planMedicationBackfill,
 stageMedicationBackfill,
 type VerifiedBackup,
} from '../src/backfill.js';

if(existsSync('.env.backfill'))process.loadEnvFile('.env.backfill');
const [command,...args]=process.argv.slice(2);
const value=(name:string)=>{const index=args.indexOf(name);if(index<0)return null;if(index===args.length-1||args[index+1].startsWith('--'))throw Error('MISSING_OPTION_'+name.slice(2).toUpperCase());return args[index+1];};
const flag=(name:string)=>args.includes(name);
const actor=()=>value('--actor')??process.env.HOUSEMED_BACKFILL_ACTOR??'';
const runId=()=>value('--run')??'';
const connectionString=process.env.BACKFILL_DATABASE_URL;
if(!connectionString)throw Error('BACKFILL_DATABASE_URL_REQUIRED');
const parsed=new URL(connectionString),local=/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
const pool=new pg.Pool({
 connectionString,stream:()=>new DatabaseSocket(),max:2,connectionTimeoutMillis:15000,
 ssl:local?false:{rejectUnauthorized:true,ca:readFileSync('config/supabase-ca.crt','utf8')},
 application_name:'housemed-normalization-backfill',
});

async function saveReport(prefix:string,result:unknown):Promise<string> {
 const output=resolve(value('--output')??`data/reports/${prefix}-${new Date().toISOString().replaceAll(':','-')}.json`);
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});return output;
}

try{
 let result:unknown;
 if(command==='dry-run'){
  const plan=await planMedicationBackfill(pool,new MedicationNormalizer(new RxNormClient()));
  const report=await saveReport('medication-backfill-dry-run',plan);result={status:'planned',snapshot_hash:plan.snapshot_hash,summary:plan.summary,report};
 }else if(command==='stage'){
  const backupPath=value('--backup-report');if(!backupPath)throw Error('BACKUP_REPORT_REQUIRED');
  const backup=JSON.parse(await readFile(resolve(backupPath),'utf8')) as VerifiedBackup;
  const staged=await stageMedicationBackfill(pool,new MedicationNormalizer(new RxNormClient()),backup,actor());
  const report=await saveReport(`medication-backfill-run-${staged.run_id}`,staged);result={status:'staged',run_id:staged.run_id,snapshot_hash:staged.snapshot_hash,summary:staged.summary,report};
 }else if(command==='approve'){
  result=await approveMedicationBackfill(pool,runId(),actor(),flag('--approve-collisions'));
 }else if(command==='apply'){
  const id=runId(),confirmation=value('--confirm')??'';result=await applyMedicationBackfill(pool,id,actor(),confirmation);
  result={...(result as object),compensation_confirmation:backfillConfirmation('compensate',id,(await getMedicationBackfillStatus(pool,id))!.snapshot_hash)};
 }else if(command==='compensate'){
  result=await compensateMedicationBackfill(pool,runId(),actor(),value('--confirm')??'');
 }else if(command==='status'){
  result={status:'ok',run:await getMedicationBackfillStatus(pool,value('--run')??undefined)};
 }else throw Error('Usage: npm run backfill:medications -- dry-run|stage|approve|apply|compensate|status [options]');
 console.log(JSON.stringify(result,null,2));
}catch(error){
 console.error(JSON.stringify({status:'failed',error:error instanceof Error?error.message:'BACKFILL_FAILED'}));process.exitCode=1;
}finally{await pool.end();}
