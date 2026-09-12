import {DatabaseSocket,networkFetch} from '../src/network.ts';
import pg from 'pg';
import {readFile,mkdir,writeFile,readdir,rm,mkdtemp} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {artifactRoots,digest,collectArtifacts,decodeArtifactFiles,checkEvidenceReferences,restoreArtifacts} from './backup-files.mjs';
if(existsSync('.env.worker'))process.loadEnvFile('.env.worker');
const tables=['sources','medications','medication_backfill_runs','medication_components','crawl_runs','listings','medication_backfill_items','medication_backfill_events','medication_matches','crawl_pages','offers','offer_history'];
if(!process.env.DATABASE_URL)throw Error('DATABASE_NOT_CONFIGURED');const databaseUrl=new URL(process.env.DATABASE_URL),local=/^(localhost|127\.0\.0\.1)$/.test(databaseUrl.hostname);
const live=new pg.Client({connectionString:process.env.DATABASE_URL,stream:()=>new DatabaseSocket(),connectionTimeoutMillis:15000,ssl:local?false:{rejectUnauthorized:true,ca:await readFile('config/supabase-ca.crt','utf8')}});
await live.connect();const snapshot={format:'housemed-logical-backup-v3',created_at:new Date().toISOString(),tables:{},files:[]};
try{await live.query('begin isolation level repeatable read read only');for(const table of tables)snapshot.tables[table]=(await live.query(`select * from pricing.${table} order by id`)).rows;await live.query('commit');}finally{await live.end();}
// Explicit private roots include crawler extracts, browser/identity evidence, and
// the manifests/audits needed to interpret a cohort. Never archive the workspace.
snapshot.files=await collectArtifacts(process.cwd());
checkEvidenceReferences(snapshot.tables,snapshot.files);
const basename=snapshot.created_at.replaceAll(':','-')+'.json.gz';
await mkdir('data/backups',{recursive:true});const filename='data/backups/'+basename;
const bytes=gzipSync(JSON.stringify(snapshot));await writeFile(filename,bytes,{mode:0o600});
const backupHash=digest(bytes);let verifiedArchive=bytes;
const canonicalize=value=>Array.isArray(value)?value.map(canonicalize):value&&typeof value==='object'&&!(value instanceof Date)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalize(value[key])])):value instanceof Date?value.toISOString():value;
const report={backup:filename,format:snapshot.format,created_at:snapshot.created_at,sha256:backupHash,compressed_bytes:bytes.length,
 database_state_hash:digest(Buffer.from(JSON.stringify(canonicalize(snapshot.tables)))),
 rows:Object.fromEntries(tables.map(t=>[t,snapshot.tables[t].length])),evidence_files:snapshot.files.filter(file=>file.path.startsWith('data/evidence/')).length,
 artifact_roots:Object.fromEntries(artifactRoots.map(root=>[root,snapshot.files.filter(file=>file.path.startsWith(root+'/')).length])),
 files:snapshot.files.map(({path,sha256})=>({path,sha256})),remote_verified:false,restore_verified:false};
if(process.env.SUPABASE_SECRET_KEY){
 const base=`https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object`;
 const headers={apikey:process.env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${process.env.SUPABASE_SECRET_KEY}`};
 const upload=await networkFetch(`${base}/housemed-backups/${basename}`,{method:'POST',headers:{...headers,'Content-Type':'application/gzip','x-upsert':'false'},body:bytes,signal:AbortSignal.timeout(60000)});
 if(!upload.ok)throw Error('BACKUP_UPLOAD_FAILED_'+upload.status);
 const download=await networkFetch(`${base}/authenticated/housemed-backups/${basename}`,{headers,signal:AbortSignal.timeout(60000)});
 if(!download.ok)throw Error('REMOTE_BACKUP_VERIFY_FAILED');
 verifiedArchive=Buffer.from(await download.arrayBuffer());if(digest(verifiedArchive)!==backupHash)throw Error('REMOTE_BACKUP_VERIFY_FAILED');
 const anonymous=await networkFetch(`${base}/public/housemed-backups/${basename}`,{signal:AbortSignal.timeout(60000)});
 if(![400,401,403,404].includes(anonymous.status))throw Error('BACKUP_PRIVATE_ACCESS_NOT_CONFIRMED');
 await anonymous.arrayBuffer();report.remote_private=true;report.anonymous_download_status=anonymous.status;
 report.remote_verified=true;report.remote_object='storage://housemed-backups/'+basename;
}
if(process.argv.includes('--restore-test')){
 const conn={host:resolve('.cache/pgsock'),port:65431,max:1};const bootstrap=new pg.Pool({...conn,database:'postgres'});
 let name='housemed_restore_test',created=false,restored,restoredArtifacts;
 try{
  const dir=(await bootstrap.query('show data_directory')).rows[0].data_directory;if(resolve(dir)!==resolve('.cache/pg-test'))throw Error('UNSAFE_RESTORE_TARGET');
  // An existing restore database is left untouched. Only this invocation's
  // new, isolated database may be removed during cleanup.
  if((await bootstrap.query('select 1 from pg_database where datname=$1',[name])).rowCount)name=`housemed_restore_e2e_${process.pid}_${Date.now()}`;
  await bootstrap.query(`create database ${name}`);created=true;
  restored=new pg.Client({...conn,database:name});await restored.connect();
  restoredArtifacts=await mkdtemp(resolve('.cache/restore-artifacts-'));
  for(const migration of (await readdir('supabase/migrations')).filter(x=>x.endsWith('.sql')).sort()){
   const sql=(await readFile('supabase/migrations/'+migration,'utf8')).replace(/create role housemed_\w+ nologin;/g,'');await restored.query(sql);
  }
  if(digest(verifiedArchive)!==backupHash)throw Error('BACKUP_CHECKSUM_MISMATCH');
  const decoded=JSON.parse(gunzipSync(verifiedArchive).toString()),files=decodeArtifactFiles(decoded);checkEvidenceReferences(decoded.tables,files);
  await restored.query('begin');await restored.query('truncate '+tables.map(t=>'pricing.'+t).join(',')+' restart identity');
  for(const table of tables){
   for(const row of decoded.tables[table]){
    const columns=Object.keys(row);if(columns.some(c=>!/^\w+$/.test(c)))throw Error('INVALID_BACKUP_COLUMN');
    await restored.query(`insert into pricing.${table}(${columns.join(',')}) overriding system value values(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>row[c]!==null&&typeof row[c]==='object'?JSON.stringify(row[c]):row[c]));
   }
   await restored.query(`select setval(pg_get_serial_sequence('pricing.${table}','id'),coalesce(max(id),1),max(id) is not null) from pricing.${table}`);
  }
  await restored.query('commit');
  report.restored_table_hashes={};
  for(const table of tables){const rows=(await restored.query(`select * from pricing.${table} order by id`)).rows;if(JSON.stringify(rows)!==JSON.stringify(snapshot.tables[table]))throw Error('RESTORE_DATA_MISMATCH_'+table);report.restored_table_hashes[table]=digest(JSON.stringify(rows));}
  await restoreArtifacts(restoredArtifacts,files);
  report.restored_files=files.length;report.restore_source=report.remote_verified?'downloaded_cloud_archive':'local_archive';report.restore_database=name;
  const reader=new pg.Pool({...conn,database:name,options:'-c role=housemed_reader'});let app;
  try{
   const identity=(await reader.query("select current_user as role,has_table_privilege(current_user,'pricing.offers','UPDATE') as can_update_offers")).rows[0];
   if(identity.role!=='housemed_reader'||identity.can_update_offers)throw Error('RESTORE_READER_ROLE_NOT_ENFORCED');
   const {tsImport}=await import('tsx/esm/api');const {buildApi}=await tsImport('../src/api.ts',import.meta.url);
   const token=randomBytes(32).toString('hex');app=buildApi(reader,token);await app.listen({host:'127.0.0.1',port:63815});
   const origin='http://127.0.0.1:63815',checks=[];
   const unauthorized=await fetch(origin+'/v1/sources/status',{signal:AbortSignal.timeout(10000)});if(unauthorized.status!==401)throw Error('RESTORE_API_AUTH_FAILED');checks.push({path:'/v1/sources/status',authorized:false,status:401});
   const medication=snapshot.tables.medications.find(m=>snapshot.tables.listings.some(l=>l.medication_id===m.id&&l.match_status==='verified'));
   if(!medication)throw Error('RESTORE_API_NO_VERIFIED_MEDICATION');
   for(const path of ['/v1/sources/status','/v1/normalization/backfill/status','/v1/medications?limit=100',`/v1/medications/${medication.id}/offers?include_estimates=true&limit=100`]){
    const response=await fetch(origin+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});if(response.status!==200)throw Error('RESTORE_API_READ_FAILED');
    const body=await response.json();
    if(path.startsWith('/v1/sources')){
     if(body.sources.length!==snapshot.tables.sources.length)throw Error('RESTORE_API_SOURCE_MISMATCH');
     for(const source of body.sources){const archivedSource=snapshot.tables.sources.find(s=>s.slug===source.source);if(!archivedSource||source.listings!==snapshot.tables.listings.filter(l=>l.source_id===archivedSource.id).length)throw Error('RESTORE_API_COVERAGE_MISMATCH');}
    }else if(path.startsWith('/v1/normalization')){
     if(body.run?.id!==snapshot.tables.medication_backfill_runs.at(-1)?.id)throw Error('RESTORE_API_BACKFILL_STATUS_MISMATCH');
    }else if(path.includes('/offers')){
     if(body.medication.id!==medication.id||!body.items.length)throw Error('RESTORE_API_QUOTE_MISSING');
     for(const offer of body.items){const expected=snapshot.tables.offers.find(o=>o.id===offer.offer_id);if(!expected||offer.price_cents!==expected.price_cents||offer.ordering_quantity!==expected.quantity||offer.currency!==expected.currency)throw Error('RESTORE_API_QUOTE_MISMATCH');}
    }else if(JSON.stringify(body.items.map(m=>m.id))!==JSON.stringify(snapshot.tables.medications.slice(0,100).map(m=>m.id)))throw Error('RESTORE_API_MEDICATION_MISMATCH');
    checks.push({path,authorized:true,status:response.status,items:body.items?.length,sources:body.sources?.length,offer_ids:body.items?.filter(x=>x.offer_id).map(x=>x.offer_id)});
   }
   report.http_api={origin,role:identity.role,checks,verified:true};report.restore_verified=true;
  }finally{if(app)await app.close();await reader.end();}
 }finally{
  try{if(restored)await restored.end();if(created)await bootstrap.query(`drop database ${name}`);}
  finally{await bootstrap.end();if(restoredArtifacts)await rm(restoredArtifacts,{recursive:true,force:true});}
 }
}
await writeFile(filename+'.report.json',JSON.stringify(report,null,2),{mode:0o600});
const {files,...summary}=report;console.log(JSON.stringify({...summary,file_manifest:filename+'.report.json'},null,2));
