import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve} from 'node:path';import {spawn} from 'node:child_process';
import {makePool} from './db.js';
import {validateManifest,manifestHash,dailyWindow,reliabilityReport,type ReliabilityRun} from './pilot.js';
const [action='status',...args]=process.argv.slice(2);
if(!['enable','disable','status','tick','report'].includes(action))throw Error('Usage: npm run pilot -- enable|disable|status|tick|report');
function option(name:string,fallback:string){const i=args.indexOf(name);return i<0?fallback:args[i+1]??fallback;}
interface Config {enabled:boolean;manifest_path:string;manifest_hash:string;first_window_at:string;enabled_at:string;}
const configFile='data/pilot/config.json';
async function config():Promise<Config|null>{try{return JSON.parse(await readFile(configFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
async function save(path:string,data:unknown){await mkdir(resolve(path,'..'),{recursive:true});const tmp=path+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(tmp,path);}
let state=await config();
if(action==='status'){console.log(JSON.stringify(state??{enabled:false,reason:'accepted_pilot_not_enabled'},null,2));process.exit(0);}
if(action==='disable'){if(state){state.enabled=false;await save(configFile,state);}console.log(JSON.stringify({enabled:false}));process.exit(0);}
if(action==='tick'&&!state?.enabled){await save('data/reports/pilot-last-tick.json',{at:new Date().toISOString(),status:'disabled',reason:'accepted_pilot_not_enabled'});console.log('Pilot collection disabled until the audited cohort is enabled.');process.exit(0);}
if(action==='report'&&!state){await save('data/reports/reliability.json',{as_of:new Date().toISOString(),status:'not_started',reason:'accepted_pilot_not_enabled',seven_day_collection_passed:false});console.log('Seven-day reliability window has not started.');process.exit(0);}
const manifestFile=action==='enable'?option('--manifest','data/manifests/acceptance.json'):state!.manifest_path;
const manifest=validateManifest(JSON.parse(await readFile(manifestFile,'utf8')),false,true);
const expectedHash=manifestHash(manifest);
if(action!=='enable'&&state!.manifest_hash!==expectedHash)throw Error('FROZEN_MANIFEST_CHANGED');
const pool=makePool();
try{
 if(action==='enable'){
  const first=option('--first-window',new Date(Math.ceil((Date.now()+1)/3600000)*3600000).toISOString());
  if(!Number.isFinite(Date.parse(first))||Date.parse(first)<Date.now())throw Error('FIRST_WINDOW_MUST_BE_IN_FUTURE');
  const rows=(await pool.query(`select p.id,p.url,s.slug,l.source_product_key,l.match_status from pricing.crawl_pages p join pricing.sources s on s.id=p.source_id
   left join pricing.listings l on l.id=p.listing_id where p.id=any($1::bigint[])`,[manifest.listings.map(x=>x.page_id)])).rows;
  for(const item of manifest.listings){const row=rows.find(x=>x.id===item.page_id&&x.slug===item.source);if(!row||row.url!==item.url||row.source_product_key!==item.source_product_key||row.match_status!=='verified')throw Error('PILOT_DATABASE_IDENTITY_NOT_VERIFIED');}
  if(state?.enabled)throw Error('DISABLE_EXISTING_PILOT_BEFORE_ENABLING_NEW_WINDOW');
  const previous=state;
  state={enabled:true,manifest_path:resolve(manifestFile),manifest_hash:expectedHash,first_window_at:new Date(first).toISOString(),enabled_at:new Date().toISOString()};
  if(previous)await save('data/pilot/previous-'+previous.enabled_at.replaceAll(':','-')+'.json',previous);
  await save(configFile,state);console.log(JSON.stringify(state));
 }
 const report=async()=>{
  const rows=(await pool.query(`select r.id,s.slug as source,r.status,r.started_at,r.finished_at,r.summary,r.checkpoint
   from pricing.crawl_runs r join pricing.sources s on s.id=r.source_id
   where r.started_at>=$1 and r.summary->>'scope'='scheduled' order by r.started_at,r.id`,[state!.first_window_at])).rows as ReliabilityRun[];
  const result=reliabilityReport(manifest,state!.first_window_at,rows);await save('data/reports/reliability.json',{enabled:state!.enabled,...result});return result;
 };
 if(action==='tick'){
  const lock=await pool.connect(),abort=new AbortController();let lockLost=false;
  lock.on('error',()=>{lockLost=true;abort.abort();console.error(JSON.stringify({event:'scheduler_lock_connection_lost'}));});
  const locked=(await lock.query("select pg_try_advisory_lock(hashtextextended('housemed:pilot-scheduler',0)) as locked")).rows[0].locked;
  if(!locked){lock.release();console.log('Another pilot tick is running.');process.exitCode=0;}
  else try{
   const window=dailyWindow(state!.first_window_at,new Date());
   if(!window?.open)await save('data/reports/pilot-last-tick.json',{at:new Date().toISOString(),status:window?'window_closed':'waiting_for_first_window',window});
   else {
    const runSource=async(source:'healthwarehouse'|'costplus')=>{
     const latest=(await pool.query(`select r.* from pricing.crawl_runs r join pricing.sources s on s.id=r.source_id where s.slug=$1 order by started_at desc,r.id desc limit 1`,[source])).rows[0];
     if(latest?.summary?.source_paused)return {source,status:'paused',reason:latest.summary.reason};
     const attempts=(await pool.query(`select r.id,r.checkpoint from pricing.crawl_runs r join pricing.sources s on s.id=r.source_id
      where s.slug=$1 and r.summary->>'scope'='scheduled' and r.summary->>'window_start'=$2 and r.summary->>'manifest_hash'=$3 order by r.started_at desc,r.id desc`,[source,window.start,expectedHash])).rows;
     if(attempts.some(r=>Number(r.checkpoint.manifest_index)>=100))return {source,status:'already_attempted_full_cohort'};
     if(attempts.length>=3)return {source,status:'process_restart_limit_reached'};
     if(abort.signal.aborted)return {source,status:'scheduler_lock_lost'};
     const exit=await new Promise<number|null>((done,reject)=>{
      const child=spawn(process.execPath,['--import','tsx',resolve('src/cli.ts'),'collect',source,'--manifest',resolve(manifestFile),'--minutes','120','--max-pages','100','--scheduled','--window-start',window.start],{cwd:process.cwd(),env:{...process.env,HOUSEMED_SCHEDULED_RUN:'1'},stdio:'inherit'});
      let killTimer:ReturnType<typeof setTimeout>|undefined;
      const stop=()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),30000);};
      abort.signal.addEventListener('abort',stop,{once:true});
      const deadlineTimer=setTimeout(stop,Math.max(1,Date.parse(window.deadline)-Date.now()));
      const terminate=()=>stop();process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
      const cleanup=()=>{abort.signal.removeEventListener('abort',stop);clearTimeout(deadlineTimer);if(killTimer)clearTimeout(killTimer);process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',terminate);};
      child.once('error',e=>{cleanup();reject(e);});child.once('close',code=>{cleanup();done(code);});
     });return {source,status:exit===0?'worker_finished':'worker_failed',exit_code:exit};
    };
    const outcomes=await Promise.allSettled([runSource('healthwarehouse'),runSource('costplus')]);
    await save('data/reports/pilot-last-tick.json',{at:new Date().toISOString(),window,outcomes:outcomes.map(x=>x.status==='fulfilled'?x.value:{status:'scheduler_error',reason:x.reason instanceof Error?x.reason.message:'unknown_error'})});
   }
  }finally{if(!lockLost)await lock.query("select pg_advisory_unlock(hashtextextended('housemed:pilot-scheduler',0))").catch(()=>{lockLost=true;});lock.release(lockLost);}
 }
 const result=await report();console.log(JSON.stringify({first_window_at:result.first_window_at,consecutive_passing_windows:result.consecutive_passing_windows,seven_day_collection_passed:result.seven_day_collection_passed}));
}finally{await pool.end();}
