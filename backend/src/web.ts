// Price-comparison web app: serves the search UI and the mock pricing API it reads.
// Separate from src/api.ts, which is the token-protected read API over collected observations.
import Fastify from 'fastify';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {lookupComparison, searchMedications, DAYS_SUPPLY} from './pricing-catalog.js';
import {registerPrescriptionChat, agentCoreInvoker, type ChatConfig} from './prescription-chat.js';

const assets:Record<string,{file:string;type:string}>={
 '/':{file:'index.html',type:'text/html; charset=utf-8'},
 '/index.html':{file:'index.html',type:'text/html; charset=utf-8'},
 '/styles.css':{file:'styles.css',type:'text/css; charset=utf-8'},
 '/app.js':{file:'app.js',type:'text/javascript; charset=utf-8'},
};
const webDir=new URL('../web/',import.meta.url);
const read=(file:string)=>readFileSync(fileURLToPath(new URL(file,webDir)),'utf8');

export function buildWeb(chat?:ChatConfig){
 const app=Fastify({logger:false,bodyLimit:16384,requestTimeout:10000});
 app.setErrorHandler((error,req,reply)=>{
  if((error as {validation?:unknown}).validation)return reply.code(400).send({error:'invalid_request'});
  req.log.error({code:(error as {code?:string}).code},'Request failed');
  return reply.code(503).send({error:'service_unavailable'});
 });
 for(const [route,asset] of Object.entries(assets))
  app.get(route,async(_req,reply)=>reply.type(asset.type).send(read(asset.file)));
 registerPrescriptionChat(app,chat);

 app.get<{Querystring:{q?:string;limit?:number}}>('/v1/medications',{schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',minLength:1,maxLength:120},limit:{type:'integer',minimum:1,maximum:25,default:8}}}}},async req=>({
  items:searchMedications(req.query.q??'',req.query.limit??8).map(m=>({name:m.name,brand_name:m.brand_name,form:m.form,strengths:m.strengths.map(s=>s.strength)})),
 }));

 app.get<{Querystring:{medication:string;strength?:string}}>('/v1/price-comparison',{schema:{querystring:{type:'object',additionalProperties:false,required:['medication'],properties:{medication:{type:'string',minLength:2,maxLength:120},strength:{type:'string',maxLength:32}}}}},async(req,reply)=>{
  const comparison=lookupComparison({medication:req.query.medication,strength:req.query.strength??null});
  if(!comparison)return reply.code(404).send({error:'medication_not_found',medication:req.query.medication,days_supply_options:[...DAYS_SUPPLY]});
  return comparison;
 });

 app.get('/healthz',async()=>({status:'ok',data_source:'mock'}));
 return app;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(existsSync('.env.agentcore'))process.loadEnvFile('.env.agentcore');
 const host=process.env.WEB_HOST??'127.0.0.1',port=Number(process.env.WEB_PORT??63814);
 const arn=process.env.HOUSEMED_AGENT_RUNTIME_ARN,householdId=process.env.HOUSEMED_HOUSEHOLD_ID;
 const app=buildWeb(arn&&householdId?{householdId,householdName:process.env.HOUSEMED_HOUSEHOLD_NAME,origin:`http://${host}:${port}`,invoke:agentCoreInvoker(arn,process.env.AWS_REGION??'us-east-1',process.env.AWS_PROFILE)}:undefined);
 const close=async()=>{await app.close();};
 process.once('SIGTERM',close);process.once('SIGINT',close);
 await app.listen({host,port});
 console.log(`HouseMeds price-comparison UI on http://${host}:${port} (mock pricing data)`);
}
