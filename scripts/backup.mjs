import pg from 'pg';
import {readFile,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
process.loadEnvFile('.env.worker');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const tables=['sources','medications','crawl_runs','listings','crawl_pages','offers','offer_history'];
const live=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true,ca:await readFile('config/supabase-ca.crt','utf8')},connectionTimeoutMillis:15000});
await live.connect();const snapshot={format:'housemed-logical-backup-v2',created_at:new Date().toISOString(),tables:{},evidence:[]};
try{await live.query('begin isolation level repeatable read read only');for(const table of tables)snapshot.tables[table]=(await live.query(`select * from pricing.${table} order by id`)).rows;await live.query('commit');}finally{await live.end();}
for(const run of snapshot.tables.crawl_runs){
 const source=snapshot.tables.sources.find(x=>x.id===run.source_id).slug;
 const directory=`${source}/${run.id}`;let files=[];
 try{files=await readdir('data/evidence/'+directory);}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const file of files){
  if(!/^[a-f0-9]{20}-[a-f0-9]{64}\.json$/.test(file))throw Error('UNEXPECTED_EVIDENCE_FILENAME');
  const path=directory+'/'+file;const body=await readFile('data/evidence/'+path,'utf8');
  const sha256=digest(body);if(!file.endsWith('-'+sha256+'.json'))throw Error('EVIDENCE_CHECKSUM_MISMATCH');
  snapshot.evidence.push({path,sha256,body});
 }
}
// Every evidence reference persisted in this snapshot must be recoverable from the archive.
const archived=new Set(snapshot.evidence.map(x=>x.path));
function checkReferences(value){
 if(typeof value==='string'&&/^(?:storage:\/\/housemed-evidence\/|local:\/\/)/.test(value)){
  const path=value.replace(/^(?:storage:\/\/housemed-evidence\/|local:\/\/)/,'');
  if(!archived.has(path))throw Error('BACKUP_MISSING_REFERENCED_EVIDENCE');
 }else if(Array.isArray(value))value.forEach(checkReferences);
 else if(value&&typeof value==='object')Object.values(value).forEach(checkReferences);
}
checkReferences(snapshot.tables);
const basename=snapshot.created_at.replaceAll(':','-')+'.json.gz';
await mkdir('data/backups',{recursive:true});const filename='data/backups/'+basename;
const bytes=gzipSync(JSON.stringify(snapshot));await writeFile(filename,bytes,{mode:0o600});
const backupHash=digest(bytes);const report={backup:filename,sha256:backupHash,rows:Object.fromEntries(tables.map(t=>[t,snapshot.tables[t].length])),evidence_files:snapshot.evidence.length,remote_verified:false,restore_verified:false};
if(process.env.SUPABASE_SECRET_KEY){
 const base=`https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object`;
 const headers={apikey:process.env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${process.env.SUPABASE_SECRET_KEY}`};
 const upload=await fetch(`${base}/housemed-backups/${basename}`,{method:'POST',headers:{...headers,'Content-Type':'application/gzip','x-upsert':'false'},body:bytes,signal:AbortSignal.timeout(60000)});
 if(!upload.ok)throw Error('BACKUP_UPLOAD_FAILED_'+upload.status);
 const download=await fetch(`${base}/authenticated/housemed-backups/${basename}`,{headers,signal:AbortSignal.timeout(60000)});
 if(!download.ok||digest(Buffer.from(await download.arrayBuffer()))!==backupHash)throw Error('REMOTE_BACKUP_VERIFY_FAILED');
 report.remote_verified=true;
}
if(process.argv.includes('--restore-test')){
 const conn={host:resolve('.cache/pgsock'),port:65431,max:1};const bootstrap=new pg.Pool({...conn,database:'postgres'});
 const dir=(await bootstrap.query('show data_directory')).rows[0].data_directory;if(resolve(dir)!==resolve('.cache/pg-test'))throw Error('UNSAFE_RESTORE_TARGET');
 const name='housemed_restore_test';await bootstrap.query(`drop database if exists ${name} with(force)`);await bootstrap.query(`create database ${name}`);
 const restored=new pg.Client({...conn,database:name});await restored.connect();
 const restoredEvidence=resolve('.cache/restore-evidence',basename);
 try{
  for(const migration of (await readdir('supabase/migrations')).filter(x=>x.endsWith('.sql')).sort()){
   const sql=(await readFile('supabase/migrations/'+migration,'utf8')).replace(/create role housemed_\w+ nologin;/g,'');await restored.query(sql);
  }
  await restored.query('begin');await restored.query('truncate '+tables.map(t=>'pricing.'+t).join(',')+' restart identity');
  const archive=await readFile(filename);if(digest(archive)!==backupHash)throw Error('BACKUP_CHECKSUM_MISMATCH');
  const decoded=JSON.parse(gunzipSync(archive).toString());
  for(const table of tables){
   for(const row of decoded.tables[table]){
    const columns=Object.keys(row);if(columns.some(c=>!/^\w+$/.test(c)))throw Error('INVALID_BACKUP_COLUMN');
    await restored.query(`insert into pricing.${table}(${columns.join(',')}) overriding system value values(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>row[c]));
   }
   await restored.query(`select setval(pg_get_serial_sequence('pricing.${table}','id'),coalesce(max(id),1),max(id) is not null) from pricing.${table}`);
  }
  await restored.query('commit');
  for(const table of tables){const rows=(await restored.query(`select * from pricing.${table} order by id`)).rows;if(JSON.stringify(rows)!==JSON.stringify(snapshot.tables[table]))throw Error('RESTORE_DATA_MISMATCH_'+table);}
  for(const file of decoded.evidence){
   if(!/^(healthwarehouse|costplus)\/\d+\/[a-f0-9]{20}-[a-f0-9]{64}\.json$/.test(file.path)||digest(file.body)!==file.sha256)throw Error('INVALID_RESTORE_EVIDENCE');
   const target=resolve(restoredEvidence,file.path);await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,file.body,{mode:0o600});
   if(digest(await readFile(target))!==file.sha256)throw Error('RESTORED_EVIDENCE_MISMATCH');
  }
  await restored.query('set role housemed_reader');await restored.query('select count(*) from pricing.sources');await restored.query('select count(*) from pricing.offers');report.restore_verified=true;
 }finally{await restored.end();await bootstrap.query(`drop database ${name} with(force)`);await bootstrap.end();await rm(restoredEvidence,{recursive:true,force:true});}
}
await writeFile(filename+'.report.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
