import {randomBytes, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {FastifyInstance} from 'fastify';
import {prescriptionInput} from './prescription-contract.js';
import type {AgentInvoker} from './agentcore-client.js';
export {agentCoreInvoker} from './agentcore-client.js';
export type {AgentInvoker} from './agentcore-client.js';

export interface ChatConfig {householdId:string; householdName?:string; invoke:AgentInvoker; origin:string;}

export function registerPrescriptionChat(app:FastifyInstance,config?:ChatConfig){
 const sessions=new Map<string,{id:string;expires:number;busy:boolean}>();
 const origin=config?.origin??'http://127.0.0.1:63814';
 const expected=new URL(origin);
 // This web host is the local, single-household adapter. Public hosting requires an authenticated tenant resolver.
 if(!['127.0.0.1','localhost','[::1]'].includes(expected.hostname))throw Error('CHAT_REQUIRES_LOOPBACK_OR_AUTHENTICATED_ADAPTER');
 const sameHost=(host:string|undefined)=>host===expected.host;
 for(const [route,source] of [['/prescriptions','../web/prescriptions.html']])app.get(route,async(req,reply)=>{
  if(!sameHost(req.headers.host))return reply.code(403).send({error:'invalid_host'});
  for(const [key,s] of sessions)if(s.expires<Date.now())sessions.delete(key);
  if(sessions.size>=100)return reply.code(429).send({error:'too_many_sessions'});
  const key=randomBytes(32).toString('hex');
  sessions.set(key,{id:randomUUID(),expires:Date.now()+8*60*60*1000,busy:false});
  return reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'self'; img-src 'self' blob: data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
   .header('Set-Cookie',`housemed_chat=${key}; HttpOnly; SameSite=Strict; Path=/v1/prescription-chat; Max-Age=28800`).type('text/html').send(readFileSync(new URL(source,import.meta.url),'utf8'));
 });
 for(const route of ['/app','/app/'])app.get(route,async(_req,reply)=>reply.redirect(process.env.HOUSEMED_FRONTEND_URL??'http://127.0.0.1:5173'));
 for(const [route,file,type] of [['/prescriptions.js','prescriptions.js','text/javascript'],['/prescriptions.css','prescriptions.css','text/css']])
  app.get(route,async(_req,reply)=>reply.type(type).send(readFileSync(new URL('../web/'+file,import.meta.url),'utf8')));
 app.get('/heic-to.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../node_modules/heic-to/dist/csp/heic-to.js',import.meta.url),'utf8')));
 app.register(async routes=>{
  routes.addHook('onRequest',async(req,reply)=>{
   reply.header('Cache-Control','no-store');
   if(!sameHost(req.headers.host)|| (req.method==='POST'&&req.headers.origin!==origin))return reply.code(403).send({error:'invalid_origin'});
   const key=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('housemed_chat='))?.slice(14);
   const session=key?sessions.get(key):undefined;
   if(!session||session.expires<Date.now())return reply.code(401).send({error:'session_expired',message:'Reload the prescription page to start a session.'});
   if(!config)return reply.code(503).send({error:'agent_not_configured',message:'The prescription service is being configured.'});
  });
  const sessionFor=(cookie?:string)=>sessions.get(cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('housemed_chat='))?.slice(14)??'')!;
  async function run(body:Record<string,unknown>,cookie?:string){
   const session=sessionFor(cookie);
   if(session.busy)return {status:'error',error:'request_in_progress',message:'Wait for the current request to finish.'};
   session.busy=true;
   try{return {...await config!.invoke({...body,household_id:config!.householdId},session.id),household_name:config!.householdName??'Your household'};}
   catch{return {status:'error',error:'agent_unavailable',message:'The prescription service could not respond. Retry safely; a draft can only be saved once.'};}
   finally{session.busy=false;}
  }
  routes.get('/v1/prescription-chat/state',async(req,reply)=>{
   const result=await run({action:'state',request_id:randomUUID()},req.headers.cookie);
   return reply.code(result.status==='error'?502:200).send(result);
  });
  routes.post('/v1/prescription-chat',{bodyLimit:5_200_000},async(req,reply)=>{
   const parsed=prescriptionInput.safeParse(req.body);
   if(!parsed.success)return reply.code(400).send({error:'invalid_request',message:'Check the prescription fields and upload a JPEG, PNG or WebP under 3.75 MB.'});
   const result=await run(parsed.data,req.headers.cookie);
   return reply.code(result.status==='error'?502:200).send(result);
  });
 });
}
