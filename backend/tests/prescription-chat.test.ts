import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildWeb} from '../src/web.js';

const origin='http://127.0.0.1:63814';
test('chat adapter binds tenant on server, protects writes, validates photos and exposes the runtime response',async()=>{
 const householdId=randomUUID(),seen:any[]=[];
 const app=buildWeb({origin,householdId,invoke:async(payload,sessionId)=>{seen.push({payload,sessionId});return {status:'ready',members:[],prescriptions:[],provider:'aws-agentcore',aws_request_id:'aws-id'};}});
 try{
  const denied=await app.inject({method:'GET',url:'/v1/prescription-chat/state',headers:{host:'127.0.0.1:63814'}});assert.equal(denied.statusCode,401);
  const page=await app.inject({method:'GET',url:'/prescriptions',headers:{host:'127.0.0.1:63814'}});assert.equal(page.statusCode,200);
  assert.match(page.headers['set-cookie'] as string,/HttpOnly; SameSite=Strict/);
  const cookie=(page.headers['set-cookie'] as string).split(';')[0],headers={host:'127.0.0.1:63814',origin,cookie};
  const body={action:'chat',message:'Hello',request_id:randomUUID()};
  for(const payload of [{...body,household_id:randomUUID()},{...body,image:{format:'png',data:'bm90LWFuLWltYWdl'}}])
   assert.equal((await app.inject({method:'POST',url:'/v1/prescription-chat',headers,payload})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/v1/prescription-chat',headers:{...headers,origin:'https://evil.example'},payload:body})).statusCode,403);
  assert.equal((await app.inject({method:'GET',url:'/prescriptions',headers:{host:'evil.example'}})).statusCode,403);
  const ok=await app.inject({method:'POST',url:'/v1/prescription-chat',headers,payload:body});assert.equal(ok.statusCode,200);
  assert.equal(ok.json().aws_request_id,'aws-id');assert.equal(seen.length,1);assert.equal(seen[0].payload.household_id,householdId);assert.ok(seen[0].sessionId.length>=33);
 }finally{await app.close();}
});

test('mobile UI redirects to its independent frontend server',async()=>{
 const app=buildWeb();
 try{
  const response=await app.inject('/app/');
  assert.equal(response.statusCode,302);
  assert.equal(response.headers.location,'http://127.0.0.1:5173');
 }finally{await app.close();}
});
