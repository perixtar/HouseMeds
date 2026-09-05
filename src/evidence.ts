import {networkFetch} from './network.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import { hash, stable, type Json, type SourceSlug } from './core.js';
export class EvidenceStore {
 constructor(private root='data/evidence'){}
 async put(source:SourceSlug,runId:string,key:string,payload:Json):Promise<string>{
  const body=stable(payload), relative=`${source}/${runId}/${hash(key).slice(0,20)}-${hash(body)}.json`;
  const path=resolve(this.root,relative);await mkdir(dirname(path),{recursive:true});
  try{await writeFile(path,body,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await readFile(path,'utf8')!==body)throw Error('EVIDENCE_HASH_CONFLICT');}
  if(process.env.SUPABASE_SECRET_KEY){
   const url=`https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/housemed-evidence/${relative}`;
   for(let attempt=0;attempt<3;attempt++){
    let response:Response;
    try{response=await networkFetch(url,{method:'POST',headers:{apikey:process.env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${process.env.SUPABASE_SECRET_KEY}`,'Content-Type':'application/json','x-upsert':'false'},body,signal:AbortSignal.timeout(30000)});}
    catch(error){
     const e=error as Error&{code?:string;cause?:{code?:string}},code=e.cause?.code??e.code??'';
     const transient=e.name==='TimeoutError'||['EAI_AGAIN','ETIMEOUT','ECANCELLED','ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','EPIPE','EADDRNOTAVAIL','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'].includes(code);
     if(!transient||attempt===2)throw error;await delay(500*2**attempt);continue;
    }
    if(response.status>=500&&response.status<600&&!response.headers.has('retry-after')&&attempt<2){await response.body?.cancel();await delay(500*2**attempt);continue;}
    if(!response.ok){const data=await response.json().catch(()=>({})) as {statusCode?:string,error?:string};if(data.statusCode!=='409'&&data.error!=='Duplicate')throw Error('EVIDENCE_UPLOAD_FAILED_'+response.status);}
    else await response.body?.cancel();
    return 'storage://housemed-evidence/'+relative;
   }
   throw Error('EVIDENCE_UPLOAD_FAILED');
  }
  return 'local://'+relative;
 }
}
