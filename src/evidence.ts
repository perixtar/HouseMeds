import {networkFetch} from './network.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hash, stable, type Json, type SourceSlug } from './core.js';
export class EvidenceStore {
 constructor(private root='data/evidence'){}
 async put(source:SourceSlug,runId:string,key:string,payload:Json):Promise<string>{
  const body=stable(payload), relative=`${source}/${runId}/${hash(key).slice(0,20)}-${hash(body)}.json`;
  const path=resolve(this.root,relative);await mkdir(dirname(path),{recursive:true});
  try{await writeFile(path,body,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await readFile(path,'utf8')!==body)throw Error('EVIDENCE_HASH_CONFLICT');}
  if(process.env.SUPABASE_SECRET_KEY){
   const response=await networkFetch(`https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/housemed-evidence/${relative}`,{method:'POST',headers:{apikey:process.env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${process.env.SUPABASE_SECRET_KEY}`,'Content-Type':'application/json','x-upsert':'false'},body,signal:AbortSignal.timeout(30000)});
   if(!response.ok){const data=await response.json() as {statusCode?:string,error?:string};if(data.statusCode!=='409'&&data.error!=='Duplicate')throw Error('EVIDENCE_UPLOAD_FAILED_'+response.status);}
   return 'storage://housemed-evidence/'+relative;
  }
  return 'local://'+relative;
 }
}
