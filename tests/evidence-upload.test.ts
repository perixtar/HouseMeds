import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {EvidenceStore} from '../src/evidence.js';

async function fixture(t:import('node:test').TestContext){
 const root=await mkdtemp(join(tmpdir(),'housemed-upload-'));
 const previous={key:process.env.SUPABASE_SECRET_KEY,project:process.env.SUPABASE_PROJECT_REF};
 process.env.SUPABASE_SECRET_KEY='fixture-secret';process.env.SUPABASE_PROJECT_REF='fixture-project';
 t.after(async()=>{await rm(root,{recursive:true,force:true});for(const [name,value] of Object.entries({SUPABASE_SECRET_KEY:previous.key,SUPABASE_PROJECT_REF:previous.project})){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
 return {root,store:new EvidenceStore(root)};
}
const transient=()=>new TypeError('fetch failed',{cause:Object.assign(Error('fixture connection reset'),{code:'ECONNRESET'})});

test('evidence upload retries a transient connection failure without changing its immutable request',async t=>{
 const {root,store}=await fixture(t);let calls=0;const requests:{url:string;options:RequestInit}[]=[];
 const fetch=t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,options:RequestInit)=>{requests.push({url:String(url),options});if(++calls===1)throw transient();return new Response('',{status:200});});
 const ref=await store.put('healthwarehouse','fixture','page',{price:'9.00'});
 assert.equal(fetch.mock.callCount(),2);assert.ok(ref.startsWith('storage://housemed-evidence/'));
 assert.equal(requests[0].url,requests[1].url);assert.equal(requests[0].options.body,requests[1].options.body);
 assert.equal(new Headers(requests[0].options.headers).get('x-upsert'),'false');assert.equal(requests[0].options.method,'POST');
 assert.equal(await readFile(join(root,ref.replace('storage://housemed-evidence/','')),'utf8'),requests[0].options.body);
});

test('evidence upload retries a transient server failure before returning a storage reference',{timeout:5000},async t=>{
 const {store}=await fixture(t);let calls=0,finished=false,confirm!:(response:Response)=>void;
 let reachedRetry!:()=>void;const retried=new Promise<void>(resolve=>{reachedRetry=resolve;});
 const fetch=t.mock.method(globalThis,'fetch',async()=>{if(++calls===1)return new Response('temporary outage',{status:503});return new Promise<Response>(resolve=>{confirm=resolve;reachedRetry();});});
 const pending=store.put('healthwarehouse','fixture','server-error',{price:'9.00'}).then(x=>{finished=true;return x;});
 await retried;
 assert.equal(finished,false);confirm(new Response('',{status:200}));assert.ok((await pending).startsWith('storage://'));assert.equal(fetch.mock.callCount(),2);
});

test('evidence upload stops after three transient failures and retains its local copy',async t=>{
 const {root,store}=await fixture(t);let localPath='';
 const fetch=t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{localPath=String(url).split('/housemed-evidence/')[1];throw transient();});
 await assert.rejects(store.put('healthwarehouse','fixture','exhausted',{price:'9.00'}),/fetch failed/);
 assert.equal(fetch.mock.callCount(),3);assert.deepEqual(JSON.parse(await readFile(join(root,localPath),'utf8')),{price:'9.00'});
});

test('evidence upload bounds server failures to three attempts',async t=>{
 const {store}=await fixture(t);const fetch=t.mock.method(globalThis,'fetch',async()=>new Response('service unavailable',{status:503}));
 await assert.rejects(store.put('healthwarehouse','fixture','server-exhausted',{}),/EVIDENCE_UPLOAD_FAILED_503/);assert.equal(fetch.mock.callCount(),3);
});

test('an upload that timed out after succeeding accepts the duplicate response on its retry',async t=>{
 const {store}=await fixture(t);let calls=0;const paths:string[]=[],bodies:unknown[]=[];
 const fetch=t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,options:RequestInit)=>{paths.push(String(url));bodies.push(options.body);if(++calls===1)throw new DOMException('fixture upload timeout','TimeoutError');return Response.json({statusCode:'409',error:'Duplicate'},{status:400});});
 assert.ok((await store.put('healthwarehouse','fixture','timed-out',{})).startsWith('storage://housemed-evidence/'));
 assert.equal(fetch.mock.callCount(),2);assert.equal(paths[0],paths[1]);assert.equal(bodies[0],bodies[1]);
});

test('permission, validation, rate-limit and Retry-After responses are not retried',async t=>{
 const {store}=await fixture(t);
 for(const status of [401,403,422,429,503]){
  const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({error:'fixture failure'},{status,headers:status===429||status===503?{'Retry-After':'120'}:{}}));
  await assert.rejects(store.put('healthwarehouse','fixture','permanent-'+status,{}),new RegExp('EVIDENCE_UPLOAD_FAILED_'+status));assert.equal(fetch.mock.callCount(),1);fetch.mock.restore();
 }
});

test('non-transient client errors are not retried',async t=>{
 const {store}=await fixture(t);const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('fixture invalid request');});
 await assert.rejects(store.put('healthwarehouse','fixture','invalid',{}),/fixture invalid request/);assert.equal(fetch.mock.callCount(),1);
});
