import test from 'node:test';import assert from 'node:assert/strict';
import {SourceClient,SourceAccessError} from '../src/sources.js';import {CP_API} from '../src/core.js';

test('403 and 429 pause immediately without repeated requests',async t=>{
 const client=new SourceClient('costplus');t.mock.method(client,'pace',async()=>{});
 const blocked=t.mock.method(globalThis,'fetch',async()=>new Response('',{status:403}));
 await assert.rejects(client.json(CP_API),(e:unknown)=>e instanceof SourceAccessError&&e.code==='SOURCE_BLOCKED');assert.equal(blocked.mock.callCount(),1);
 blocked.mock.restore();const limited=t.mock.method(globalThis,'fetch',async()=>new Response('',{status:429,headers:{'Retry-After':'120'}}));
 await assert.rejects(client.json(CP_API),(e:unknown)=>e instanceof SourceAccessError&&e.code==='SOURCE_RATE_LIMITED'&&e.retryAfter===120);assert.equal(limited.mock.callCount(),1);
});
test('transient server failures retry but permanent 404 does not',async t=>{
 const client=new SourceClient('costplus');t.mock.method(client,'pace',async()=>{});let n=0;
 const response=t.mock.method(globalThis,'fetch',async()=>++n<2?new Response('',{status:503}):Response.json({results:[]}));
 assert.deepEqual(await client.json(CP_API),{results:[]});assert.equal(response.mock.callCount(),2);response.mock.restore();
 const missing=t.mock.method(globalThis,'fetch',async()=>new Response('',{status:404}));await assert.rejects(client.json(CP_API),/HTTP_404/);assert.equal(missing.mock.callCount(),1);
});
test('network failure retries are bounded and do not fabricate a successful response',async t=>{
 const client=new SourceClient('costplus');t.mock.method(client,'pace',async()=>{});
 const network=t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('Local test timeout','TimeoutError');});
 await assert.rejects(client.json(CP_API),/FETCH_TIMEOUT/);assert.equal(network.mock.callCount(),3);
});
test('API redirects, foreign hosts and private paths are not followed',async t=>{
 const client=new SourceClient('costplus');t.mock.method(client,'pace',async()=>{});
 const redirect=t.mock.method(globalThis,'fetch',async()=>new Response('',{status:302,headers:{Location:'https://example.com/private'}}));
 await assert.rejects(client.json(CP_API),/UNAPPROVED_REDIRECT/);assert.equal(redirect.mock.callCount(),1);
 await assert.rejects(client.json(CP_API+'/another'),/UNAPPROVED_API_URL/);
 await assert.rejects(client.get('https://www.costplusdrugs.com/account/'),/URL_EXCLUDED/);assert.equal(redirect.mock.callCount(),1);
});
