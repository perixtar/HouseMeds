// Mock household API and static frontend host. Replace the in-memory store with
// repository-backed handlers without changing the frontend request contract.
import Fastify from 'fastify';
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';

type UnitValue={amount:number;unit:string};
type Medication={id:string;rxnorm_id:string|null;internal_med_id:string;name:string;strength:UnitValue|null;form:string};
type Prescription={id:string;medication:Medication;dose:UnitValue;frequency:string;prescriber_name:string|null;fulfillment:{pharmacy:string|null;quantity:UnitValue;refills:number};recommendation:null|{pharmacy:string;quantity:UnitValue;refills:number;status:'draft'|'ready_to_request'|'requested'|'accepted'|'declined'}};
type Member={id:string;name:string;prescriptions:Prescription[]};

const account={id:'acct_demo',name:'Demo account'};
const house={id:'house_demo',name:'My house'};
const members:Member[]=[];
const frontendDir=new URL('../../frontend/',import.meta.url);
const assets:Record<string,string>={'/':'mock/index.html','/index.html':'mock/index.html','/styles.css':'styles.css','/theme.css':'theme.css','/app.js':'mock/app.js','/api.js':'mock/api.js','/back.js':'back.js'};
const readAsset=(file:string)=>readFileSync(fileURLToPath(new URL(file,frontendDir)),'utf8');
const typeFor=(file:string)=>file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8';
const id=(prefix:string)=>`${prefix}_${crypto.randomUUID()}`;
const unit=(value:unknown,fallback:UnitValue):UnitValue=>{
 const input=value as Partial<UnitValue>|undefined;
 return typeof input?.amount==='number'&&Number.isFinite(input.amount)&&typeof input.unit==='string'&&input.unit.trim()?{amount:input.amount,unit:input.unit.trim()}:fallback;
};
const frequencyLabel=(frequency:string)=>frequency.replaceAll('_',' ');

export function buildHouseholdMock(){
 const app=Fastify({logger:false,bodyLimit:16384,requestTimeout:10000});
 app.setErrorHandler((error,req,reply)=>{
  if((error as {validation?:unknown}).validation)return reply.code(400).send({error:'invalid_request'});
  req.log.error(error);return reply.code(500).send({error:'mock_service_error'});
 });
 for(const [route,file] of Object.entries(assets))app.get(route,async(_req,reply)=>reply.type(typeFor(file)).send(readAsset(file)));

 // The account is inferred from session auth in production; this mock always uses acct_demo.
 app.get('/v1/me/household',async()=>({account,house,members}));
 app.post<{Params:{houseId:string};Body:{name?:string}}>('/v1/houses/:houseId/members',{schema:{params:{type:'object',required:['houseId'],properties:{houseId:{type:'string'}}},body:{type:'object',required:['name'],properties:{name:{type:'string',minLength:1,maxLength:80}}}}},async(req,reply)=>{
  if(req.params.houseId!==house.id)return reply.code(404).send({error:'house_not_found'});
  const name=req.body.name!.trim();if(!name)return reply.code(400).send({error:'member_name_required'});
  const member:Member={id:id('member'),name,prescriptions:[]};members.push(member);return reply.code(201).send({member});
 });
 app.delete<{Params:{memberId:string}}>('/v1/members/:memberId',async(req,reply)=>{
  const index=members.findIndex(item=>item.id===req.params.memberId);
  if(index===-1)return reply.code(404).send({error:'member_not_found'});
  members.splice(index,1);return reply.code(204).send();
 });
 app.get<{Params:{memberId:string}}>('/v1/members/:memberId/prescriptions',async(req,reply)=>{
  const member=members.find(item=>item.id===req.params.memberId);return member?{member_id:member.id,prescriptions:member.prescriptions}:reply.code(404).send({error:'member_not_found'});
 });
 app.post<{Params:{memberId:string};Body:{medication?:Partial<Medication>;dose?:Partial<UnitValue>;frequency?:string;prescriber_name?:string|null;fulfillment?:{pharmacy?:string|null;quantity?:Partial<UnitValue>;refills?:number}}}>('/v1/members/:memberId/prescriptions',async(req,reply)=>{
  const member=members.find(item=>item.id===req.params.memberId);if(!member)return reply.code(404).send({error:'member_not_found'});
  const input=req.body??{},name=input.medication?.name?.trim();if(!name)return reply.code(400).send({error:'medication_name_required'});
  const prescription:Prescription={id:id('rx'),medication:{id:id('med'),rxnorm_id:input.medication?.rxnorm_id??null,internal_med_id:input.medication?.internal_med_id??id('mock_med'),name,strength:input.medication?.strength?unit(input.medication.strength,{amount:0,unit:''}):null,form:input.medication?.form?.trim()||'tablet'},dose:unit(input.dose,{amount:1,unit:'tablet'}),frequency:input.frequency?.trim()||'once_daily',prescriber_name:input.prescriber_name?.trim()||null,fulfillment:{pharmacy:input.fulfillment?.pharmacy?.trim()||null,quantity:unit(input.fulfillment?.quantity,{amount:30,unit:'days'}),refills:Number.isInteger(input.fulfillment?.refills)?input.fulfillment!.refills!:1},recommendation:null};
  member.prescriptions.push(prescription);return reply.code(201).send({prescription});
 });
 app.get<{Querystring:{house_id?:string}}>('/v1/deals',{schema:{querystring:{type:'object',additionalProperties:false,properties:{house_id:{type:'string'}}}}},async(req,reply)=>{
  if(req.query.house_id&&req.query.house_id!==house.id)return reply.code(404).send({error:'house_not_found'});
  const items=members.flatMap(member=>member.prescriptions.map((prescription,index)=>({prescription_id:prescription.id,member_id:member.id,member_name:member.name,medication_name:prescription.medication.name,strength:prescription.medication.strength,annual_savings_cents:index?11200:37000,best_offer:{pharmacy:prescription.recommendation?.pharmacy??'Cost Plus Drugs',price_cents:index?940:1240,days_supply:prescription.recommendation?.quantity.amount??90}})));
  return {house_id:house.id,estimated_annual_savings_cents:items.reduce((sum,item)=>sum+item.annual_savings_cents,0),items};
 });
 app.get('/healthz',async()=>({status:'ok',data_source:'mock_household_api'}));
 return app;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=buildHouseholdMock();const close=async()=>{await app.close();};process.once('SIGTERM',close);process.once('SIGINT',close);
 const host=process.env.FRONTEND_HOST??'127.0.0.1',port=Number(process.env.FRONTEND_PORT??63815);
 await app.listen({host,port});console.log(`HouseMeds frontend mock API on http://${host}:${port}`);
}
