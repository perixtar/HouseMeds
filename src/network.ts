import {Resolver} from 'node:dns/promises';import {lookup as nativeLookup,type LookupAddress} from 'node:dns';
import {Socket,type LookupFunction} from 'node:net';import {Agent} from 'undici';
type Address=LookupAddress&{ttl:number};
const cache=new Map<string,{until:number;addresses:Address[]}>(),pending=new Map<string,Promise<Address[]>>();
const publicHost=(h:string)=>h.endsWith('.pooler.supabase.com')||h.endsWith('.supabase.co')||['www.healthwarehouse.com','healthwarehouse.com','www.costplusdrugs.com','costplusdrugs.com','us-central1-costplusdrugs-publicapi.cloudfunctions.net'].includes(h);
async function query(hostname:string,family:4|6,fallback:boolean):Promise<Address[]>{
 const resolver=new Resolver({timeout:1000,tries:1});if(fallback)resolver.setServers(['1.1.1.1']);
 const timer=setTimeout(()=>resolver.cancel(),2200);
 try{const records=family===6?await resolver.resolve6(hostname,{ttl:true}):await resolver.resolve4(hostname,{ttl:true});if(!records.length)throw Error('NO_DNS_ADDRESSES');return records.map(x=>({...x,family}));}finally{clearTimeout(timer);}
}
export async function resolvePublicHost(hostname:string,family:4|6=4):Promise<Address[]>{
 if(!publicHost(hostname))throw Error('DNS_FALLBACK_HOST_NOT_ALLOWED');
 const key=hostname+':'+family,old=cache.get(key);if(old&&old.until>Date.now())return old.addresses;
 if(pending.has(key))return pending.get(key)!;
 const job=(async()=>{
  let addresses:Address[];
  try{addresses=await query(hostname,family,false);}catch{
   addresses=await query(hostname,family,true);console.warn(JSON.stringify({event:'dns_fallback',hostname,resolver:'1.1.1.1'}));
  }
  cache.set(key,{addresses,until:Date.now()+Math.max(0,Math.min(60,...addresses.map(x=>x.ttl)))*1000});return addresses;
 })();pending.set(key,job);try{return await job;}finally{pending.delete(key);}
}
export const boundedLookup:LookupFunction=(hostname,options,callback)=>{
 if(!publicHost(hostname)){nativeLookup(hostname,options,callback);return;}
 const family=options.family===6?6:4;
 void resolvePublicHost(hostname,family).then(addresses=>{
  if(options.all)callback(null,addresses.map(({address,family})=>({address,family})));else callback(null,addresses[0].address,addresses[0].family);
 },error=>callback(error,[],family));
};
export class DatabaseSocket extends Socket {
 override connect(...args:any[]):this {
  if(typeof args[0]==='number'&&typeof args[1]==='string')return super.connect({port:args[0],host:args[1],lookup:boundedLookup},args[2]);
  return Reflect.apply(Socket.prototype.connect,this,args);
 }
}
const dispatcher=new Agent({connect:{lookup:boundedLookup}});
export function networkFetch(url:string|URL,options:RequestInit={}):Promise<Response>{return fetch(url,{...options,dispatcher} as RequestInit);}
