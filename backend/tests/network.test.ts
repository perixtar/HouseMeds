import test from 'node:test';import assert from 'node:assert/strict';import dns,{type LookupAddress} from 'node:dns';import {Resolver} from 'node:dns/promises';
import {boundedLookup,resolvePublicHost} from '../src/network.js';
type NativeCallback=(error:NodeJS.ErrnoException|null,addresses:LookupAddress[])=>void;
const failedLookup=(_hostname:string,_options:unknown,callback:NativeCallback)=>queueMicrotask(()=>callback(Object.assign(Error('fixture native DNS failure'),{code:'EAI_AGAIN'}),[]));
test('approved hosts use native OS resolution first, share pending lookups, and leave its cache to the OS',async t=>{
 let release:NativeCallback;
 const native=t.mock.method(dns,'lookup',((_hostname:string,_options:unknown,callback:NativeCallback)=>{release=callback;}) as typeof dns.lookup);
 const fallback=t.mock.method(Resolver.prototype,'resolve4',async()=>{throw Error('direct DNS must not replace a working OS resolver');});
 const a=resolvePublicHost('fixture-native.supabase.co'),b=resolvePublicHost('fixture-native.supabase.co');
 release!(null,[{address:'192.0.2.1',family:4}]);assert.deepEqual(await a,await b);assert.equal(native.mock.callCount(),1);assert.equal(fallback.mock.callCount(),0);
 const c=resolvePublicHost('fixture-native.supabase.co');release!(null,[{address:'192.0.2.2',family:4}]);
 assert.equal((await c)[0].address,'192.0.2.2');assert.equal(native.mock.callCount(),2);
});
test('native failure falls back to scoped DNS, shared and cached for the shortest returned TTL',async t=>{
 let now=1_000_000;t.mock.method(Date,'now',()=>now);t.mock.method(console,'warn',()=>{});
 const native=t.mock.method(dns,'lookup',failedLookup as typeof dns.lookup);
 const fallback=t.mock.method(Resolver.prototype,'resolve4',async function(this:Resolver){assert.deepEqual(this.getServers(),['1.1.1.1']);return [{address:'192.0.2.10',ttl:2},{address:'192.0.2.11',ttl:300}];});
 const [a,b]=await Promise.all([resolvePublicHost('fixture-cache.supabase.co'),resolvePublicHost('fixture-cache.supabase.co')]);assert.deepEqual(a,b);assert.equal(a[0].address,'192.0.2.10');
 now+=1999;await resolvePublicHost('fixture-cache.supabase.co');assert.equal(native.mock.callCount(),1);assert.equal(fallback.mock.callCount(),1);
 now++;await resolvePublicHost('fixture-cache.supabase.co');assert.equal(native.mock.callCount(),2);assert.equal(fallback.mock.callCount(),2);
});
test('a stalled native lookup yields within its deadline and a late answer cannot replace the fallback',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(console,'warn',()=>{});let release:NativeCallback;
 t.mock.method(dns,'lookup',((_hostname:string,_options:unknown,callback:NativeCallback)=>{release=callback;}) as typeof dns.lookup);
 const fallback=t.mock.method(Resolver.prototype,'resolve4',async()=>[{address:'192.0.2.20',ttl:60}]);
 const answer=resolvePublicHost('fixture-native-timeout.supabase.co');t.mock.timers.tick(2199);assert.equal(fallback.mock.callCount(),0);
 t.mock.timers.tick(1);assert.equal((await answer)[0].address,'192.0.2.20');
 release!(null,[{address:'192.0.2.21',family:4}]);assert.equal((await resolvePublicHost('fixture-native-timeout.supabase.co'))[0].address,'192.0.2.20');
});
test('a stalled fallback resolver is cancelled at its deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(dns,'lookup',failedLookup as typeof dns.lookup);let rejectQuery:(error:Error)=>void;
 t.mock.method(Resolver.prototype,'resolve4',()=>new Promise((_resolve,reject)=>{rejectQuery=reject;}));
 const cancel=t.mock.method(Resolver.prototype,'cancel',()=>rejectQuery(Object.assign(Error('fixture cancelled DNS query'),{code:'ECANCELLED'})));
 const answer=resolvePublicHost('fixture-fallback-timeout.supabase.co');const rejection=assert.rejects(answer,/fixture cancelled DNS query/);
 await new Promise(setImmediate);t.mock.timers.tick(2200);await rejection;assert.equal(cancel.mock.callCount(),1);
});
test('public DNS fallback never handles unrelated or private hostnames',async t=>{
 const native=t.mock.method(dns,'lookup',((_hostname:string,options:unknown,callback:NativeCallback)=>{assert.deepEqual(options,{family:4,all:true});callback(null,[{address:'127.0.0.1',family:4}]);}) as typeof dns.lookup);
 const fallback=t.mock.method(Resolver.prototype,'resolve4',async()=>[]);
 await assert.rejects(resolvePublicHost('private.internal'),/DNS_FALLBACK_HOST_NOT_ALLOWED/);assert.equal(native.mock.callCount(),0);
 const result=await new Promise((resolve,reject)=>boundedLookup('private.internal',{family:4,all:true},(error,addresses)=>error?reject(error):resolve(addresses)));
 assert.deepEqual(result,[{address:'127.0.0.1',family:4}]);assert.equal(native.mock.callCount(),1);assert.equal(fallback.mock.callCount(),0);
});
test('failed DNS answers are not cached and concurrent retries use a fresh native lookup',async t=>{
 const native=t.mock.method(dns,'lookup',failedLookup as typeof dns.lookup);
 const fallback=t.mock.method(Resolver.prototype,'resolve4',async()=>{throw Object.assign(Error('fixture DNS failure'),{code:'ETIMEOUT'});});
 await assert.rejects(resolvePublicHost('fixture-failed.supabase.co'),/fixture DNS failure/);
 await assert.rejects(resolvePublicHost('fixture-failed.supabase.co'),/fixture DNS failure/);assert.equal(native.mock.callCount(),2);assert.equal(fallback.mock.callCount(),2);
});
test('bounded lookup preserves requested IPv6 family and returns the documented all-address callback shape',async t=>{
 t.mock.method(dns,'lookup',((_hostname:string,options:unknown,callback:NativeCallback)=>{assert.deepEqual(options,{family:6,all:true});callback(null,[{address:'2001:db8::1',family:6}]);}) as typeof dns.lookup);
 const result=await new Promise((resolve,reject)=>boundedLookup('fixture-ipv6.supabase.co',{family:6,all:true},(error,addresses)=>error?reject(error):resolve(addresses)));
 assert.deepEqual(result,[{address:'2001:db8::1',family:6}]);
});
test('idle pool disconnects are handled without logging connection objects or secrets',async t=>{
 const {makePool}=await import('../src/db.js');const previous=process.env.DATABASE_URL;process.env.DATABASE_URL='postgresql://worker@127.0.0.1:65431/housemed_test';
 const log=t.mock.method(console,'error',()=>{});const pool=makePool();
 try{pool.emit('error',Object.assign(Error('sensitive message'),{code:'57P01',client:{connectionString:'sensitive connection string'}}));
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]),{event:'database_idle_connection_error',code:'57P01'});
 }finally{await pool.end();if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;}
});
