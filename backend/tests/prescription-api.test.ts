import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildPrescriptionApi} from '../src/prescription-api.js';

const token = 'test-only-token-with-at-least-32-characters';
const householdSecret = 'server-only-test-secret-with-at-least-32-characters';
const householdKey = 'a'.repeat(64);
function setup() {
  const seen: any[] = [];
  const app = buildPrescriptionApi({apiToken: token, householdSecret, invoke: async (payload, session) => {
    seen.push({payload, session}); return {status: 'ready', provider: 'aws-agentcore', members: [], prescriptions: []};
  }});
  return {app, seen};
}

test('preflight works for every frontend without authentication or cookies', async () => {
  const {app, seen} = setup();
  try {
    for (const origin of ['http://localhost:5173', 'https://teammate.example', 'null']) {
      const r = await app.inject({method: 'OPTIONS', url: '/v1/prescription-chat', headers: {origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-housemed-session-id'}});
      assert.equal(r.statusCode, 204); assert.equal(r.headers['access-control-allow-origin'], '*');
      assert.match(String(r.headers['access-control-allow-headers']), /Authorization/);
      assert.equal(r.headers['access-control-allow-credentials'], undefined);
      assert.equal(r.headers['set-cookie'], undefined);
    }
    assert.equal(seen.length, 0);
  } finally { await app.close(); }
});

test('any origin can invoke with a token, while CORS does not bypass authorization', async () => {
  const {app, seen} = setup();
  try {
    for (const authorization of [undefined, 'Bearer wrong', 'Basic '+token]) {
      const r = await app.inject({method: 'GET', url: '/v1/prescription-chat/state', headers: {origin: 'https://any-frontend.example', ...(authorization ? {authorization} : {})}});
      assert.equal(r.statusCode, 401); assert.equal(r.headers['access-control-allow-origin'], '*');
    }
    assert.equal(seen.length, 0);
    const session = randomUUID();
    const r = await app.inject({method: 'GET', url: '/v1/prescription-chat/state', headers: {host: 'shared-api.example', origin: 'https://any-frontend.example', 'x-housemed-household-key':householdKey, authorization: 'Bearer '+token, 'x-housemed-session-id': session}});
    assert.equal(r.statusCode, 200); assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['x-housemed-session-id'], session); assert.equal(seen[0].session, session);
    assert.match(seen[0].payload.household_id,/^[a-f0-9-]{36}$/);
  } finally { await app.close(); }
});

test('API rejects tenant overrides, invalid images and malformed session IDs before AWS calls', async () => {
  const {app, seen} = setup();
  const headers = {'x-housemed-household-key':householdKey, authorization: 'Bearer '+token, origin: 'https://any.example'};
  try {
    for (const payload of [
      {action: 'chat', request_id: randomUUID(), household_id: randomUUID()},
      {action: 'prepare', request_id: randomUUID()},
      {action: 'chat', request_id: randomUUID(), image: {format: 'png', data: 'bm90LWFuLWltYWdl'}},
    ]) assert.equal((await app.inject({method: 'POST', url: '/v1/prescription-chat', headers, payload})).statusCode, 400);
    assert.equal((await app.inject({url: '/v1/prescription-chat/state', headers: {...headers, 'x-housemed-session-id': 'bad'}})).statusCode, 400);
    assert.equal(seen.length, 0);
  } finally { await app.close(); }
});

test('manual preparation and confirmation preserve client request IDs and reviewed values', async () => {
  const {app, seen} = setup();
  const fields = {medication: 'Zoloft', strength: '100 mg', form: '', directions: '', quantity: '', refills: '', prescriber: '', pharmacy: '', warnings: []};
  try {
    for (const body of [{action: 'prepare', request_id: randomUUID(), fields}, {action: 'confirm', request_id: randomUUID(), draft_id: randomUUID(), member_id: randomUUID(), fields}]) {
      const r = await app.inject({method: 'POST', url: '/v1/prescription-chat', headers: {'x-housemed-household-key':householdKey, authorization: 'Bearer '+token}, payload: body});
      assert.equal(r.statusCode, 200); assert.equal(seen.at(-1).payload.request_id, body.request_id);
      assert.deepEqual(seen.at(-1).payload.fields, fields);
    }
  } finally { await app.close(); }
});

test('runtime failures are browser-readable and do not leak internal exceptions', async () => {
  const app = buildPrescriptionApi({apiToken: token, householdSecret, invoke: async () => { throw Error('PRIVATE_UPSTREAM_DETAIL'); }});
  try {
    const r = await app.inject({url: '/v1/prescription-chat/state', headers: {origin: 'https://new-frontend.example', 'x-housemed-household-key':householdKey, authorization: 'Bearer '+token}});
    assert.equal(r.statusCode, 502); assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.json().error, 'agent_unavailable'); assert.ok(!r.body.includes('PRIVATE_UPSTREAM_DETAIL'));
  } finally { await app.close(); }
});

test('the authenticated OpenAPI spec describes the frontend request contract', async () => {
  const {app} = setup();
  try {
    const r = await app.inject({url: '/openapi.json', headers: {'x-housemed-household-key':householdKey, authorization: 'Bearer '+token}});
    assert.equal(r.statusCode, 200);
    const spec = r.json(); assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.deepEqual(spec.components.schemas.PrescriptionRequest.properties.action.enum, ['chat','confirm','confirm_all','prepare','create_member']);
  } finally { await app.close(); }
});

test('member creation validates names and binds the household before invoking AWS', async () => {
  const {app,seen}=setup(); const headers={'x-housemed-household-key':householdKey,authorization:'Bearer '+token};
  try {
    for (const nickname of [undefined,'','   ','x'.repeat(81)]) {
      assert.equal((await app.inject({method:'POST',url:'/v1/prescription-chat',headers,payload:{action:'create_member',request_id:randomUUID(),nickname}})).statusCode,400);
    }
    assert.equal(seen.length,0);
    const request_id=randomUUID();
    assert.equal((await app.inject({method:'POST',url:'/v1/prescription-chat',headers,payload:{action:'create_member',request_id,nickname:' Mom '}})).statusCode,200);
    assert.equal(seen[0].payload.nickname,'Mom'); assert.match(seen[0].payload.household_id,/^[a-f0-9-]{36}$/); assert.equal(seen[0].payload.request_id,request_id);
  } finally {await app.close();}
});

test('browser households are isolated, stable across tabs, and cannot fall back to the shared list', async () => {
  const {app,seen}=setup();
  try {
    for (const key of [undefined,'invalid']) {
      const r=await app.inject({url:'/v1/prescription-chat/state',headers:{authorization:'Bearer '+token,...(key?{'x-housemed-household-key':key}:{})}});
      assert.equal(r.statusCode,400);
    }
    assert.equal(seen.length,0);
    for(const key of [householdKey,'b'.repeat(64),householdKey]) {
      assert.equal((await app.inject({url:'/v1/prescription-chat/state',headers:{authorization:'Bearer '+token,'x-housemed-household-key':key,'x-housemed-session-id':randomUUID()}})).statusCode,200);
    }
    assert.equal(seen[0].payload.household_id,seen[2].payload.household_id);
    assert.notEqual(seen[0].payload.household_id,seen[1].payload.household_id);
  } finally {await app.close();}
});

test('batch confirmation passes reviewed edits and chat intent but rejects oversized batches', async () => {
  const {app,seen}=setup();
  const headers={'x-housemed-household-key':householdKey,authorization:'Bearer '+token};
  const fields={medication:'Example',strength:'75 mcg',form:'',directions:'',quantity:'',refills:'',prescriber:'',pharmacy:'',warnings:[]};
  const draft_id=randomUUID(),member_id=randomUUID();
  try {
    const payload={action:'confirm_all',request_id:randomUUID(),draft_id,member_id,reviewed_drafts:[{draft_id,fields}]};
    assert.equal((await app.inject({method:'POST',url:'/v1/prescription-chat',headers,payload})).statusCode,200);
    assert.deepEqual(seen[0].payload.reviewed_drafts,payload.reviewed_drafts);
    assert.equal((await app.inject({method:'POST',url:'/v1/prescription-chat',headers,payload:{...payload,action:'chat',message:'Grandma',pending_action:'confirm_all'}})).statusCode,200);
    assert.equal(seen[1].payload.pending_action,'confirm_all');
    assert.equal((await app.inject({method:'POST',url:'/v1/prescription-chat',headers,payload:{...payload,reviewed_drafts:Array(41).fill({draft_id,fields})}})).statusCode,400);
  } finally {await app.close();}
});
