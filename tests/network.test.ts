import test from 'node:test';import assert from 'node:assert/strict';import {Resolver} from 'node:dns/promises';
import {resolvePublicHost} from '../src/network.js';
test('DNS fallback is bounded, shared between simultaneous callers, and cached by returned TTL',async t=>{
 let primary=0,fallback=0;
 t.mock.method(Resolver.prototype,'resolve4',async function(this:Resolver){
  if(this.getServers().includes('1.1.1.1')){fallback++;return [{address:'192.0.2.10',ttl:60}];}
  primary++;throw Object.assign(Error('fixture DNS timeout'),{code:'ETIMEOUT'});
 });
 const [a,b]=await Promise.all([resolvePublicHost('fixture-cache.supabase.co'),resolvePublicHost('fixture-cache.supabase.co')]);assert.deepEqual(a,b);assert.equal(a[0].address,'192.0.2.10');
 await resolvePublicHost('fixture-cache.supabase.co');assert.equal(primary,1);assert.equal(fallback,1);
});
test('DNS fallback never handles unrelated or private hostnames',async t=>{
 const mock=t.mock.method(Resolver.prototype,'resolve4',async()=>[]);
 await assert.rejects(resolvePublicHost('private.internal'),/DNS_FALLBACK_HOST_NOT_ALLOWED/);assert.equal(mock.mock.callCount(),0);
});
test('failed DNS answers are not cached as successful connections',async t=>{
 const mock=t.mock.method(Resolver.prototype,'resolve4',async()=>{throw Object.assign(Error('fixture DNS failure'),{code:'ETIMEOUT'});});
 await assert.rejects(resolvePublicHost('fixture-failed.supabase.co'),/fixture DNS failure/);
 await assert.rejects(resolvePublicHost('fixture-failed.supabase.co'),/fixture DNS failure/);assert.equal(mock.mock.callCount(),4);
});
test('idle pool disconnects are handled without logging connection objects or secrets',async t=>{
 const {makePool}=await import('../src/db.js');const previous=process.env.DATABASE_URL;process.env.DATABASE_URL='postgresql://worker@127.0.0.1:65431/housemed_test';
 const log=t.mock.method(console,'error',()=>{});const pool=makePool();
 try{pool.emit('error',Object.assign(Error('sensitive message'),{code:'57P01',client:{connectionString:'sensitive connection string'}}));
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]),{event:'database_idle_connection_error',code:'57P01'});
 }finally{await pool.end();if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;}
});
