import {spawn} from 'node:child_process';import {resolve} from 'node:path';import {mkdir,writeFile,rename,readFile} from 'node:fs/promises';
import {makePool} from './db.js';import {Repository} from './repository.js';import {priceWindowTakesPriority} from './pilot.js';
const pool=makePool(),repo=new Repository(pool);const outcomes:unknown[]=[];
try{
 const config=await readFile('data/pilot/config.json','utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 for(const source of ['healthwarehouse','costplus','costco'] as const){
  try{
  const s=await repo.source(source),probe=await pool.connect();
  let free=false;try{free=(await probe.query('select pg_try_advisory_lock($1::bigint) as free',[s.id])).rows[0].free;if(free)await probe.query('select pg_advisory_unlock($1::bigint)',[s.id]);}finally{probe.release();}
  if(!free){outcomes.push({source,status:'source_busy'});continue;}
  const last=(await pool.query(`select * from pricing.crawl_runs where source_id=$1 and checkpoint->>'phase'='discover' order by started_at desc,id desc limit 1`,[s.id])).rows[0];
  const access=(await pool.query(`select summary from pricing.crawl_runs where source_id=$1 and coalesce(summary->>'access_channel','website')='website' order by started_at desc,id desc limit 1`,[s.id])).rows[0];
  if(access?.summary?.source_paused){outcomes.push({source,status:'website_paused',reason:access.summary.reason});continue;}
  if(priceWindowTakesPriority(config)){outcomes.push({source,status:'price_window_has_priority'});continue;}
  const incomplete=await repo.remainingDiscovery(s.id,null);
  const complete=(await pool.query(`select finished_at from pricing.crawl_runs where source_id=$1 and checkpoint->>'phase'='discover' and status='succeeded' order by finished_at desc limit 1`,[s.id])).rows[0];
  const resume=last&&['partial','interrupted','running','failed'].includes(last.status);
  const refresh=resume?Boolean(last.checkpoint?.discovery_cutoff):incomplete===0;
  if(!resume&&!incomplete&&complete&&Date.now()-new Date(complete.finished_at).getTime()<7*86400000){outcomes.push({source,status:'weekly_discovery_not_due'});continue;}
  const result=await new Promise<number|null>((done,reject)=>{
   const args=['--import','tsx',resolve('src/cli.ts'),'discover',source,'--max-pages','2000','--minutes','120',...(refresh?['--refresh-due']:[])];
   const child=spawn(process.execPath,args,{cwd:process.cwd(),env:process.env,stdio:'inherit'});
   const stop=()=>child.kill('SIGTERM');process.once('SIGTERM',stop);process.once('SIGINT',stop);
   const cleanup=()=>{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);};
   child.once('error',e=>{cleanup();reject(e);});child.once('close',code=>{cleanup();done(code);});
  });outcomes.push({source,status:result===0?'worker_finished':'worker_failed',mode:refresh?'refresh_due':'initial',exit_code:result});
  }catch(error){
   // A transient failure for one source must not suppress the other's outcome.
   const code=(error as NodeJS.ErrnoException).code;
   outcomes.push({source,status:'tick_failed',code:code??'UNEXPECTED_ERROR'});
  }
 }
 await mkdir('data/reports',{recursive:true});const target='data/reports/discovery-last-tick.json',tmp=target+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify({at:new Date().toISOString(),outcomes},null,2)+'\n',{mode:0o600});await rename(tmp,target);
 console.log(JSON.stringify({event:'discovery_tick_finished',outcomes}));
}finally{await pool.end();}
