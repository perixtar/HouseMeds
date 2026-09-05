import pg from 'pg';
import {DatabaseSocket} from './network.js';
import {readFileSync,existsSync} from 'node:fs';

export function makePool(readOnly=false):pg.Pool {
 const file=readOnly?'.env.api':'.env.worker';if(existsSync(file))process.loadEnvFile(file);
 const connectionString=process.env[readOnly?'READ_DATABASE_URL':'DATABASE_URL'];
 if(!connectionString)throw Error('DATABASE_NOT_CONFIGURED');
 const pool=new pg.Pool({connectionString,stream:()=>new DatabaseSocket(),max:readOnly?10:2,connectionTimeoutMillis:15000,idleTimeoutMillis:30000,ssl:/localhost|127\.0\.0\.1/.test(new URL(connectionString).hostname)?false:{rejectUnauthorized:true,ca:readFileSync('config/supabase-ca.crt','utf8')},application_name:readOnly?'housemed-api':'housemed-worker'});
 // pg removes disconnected idle clients itself. Never let its error event dump a client object.
 pool.on('error',(error)=>console.error(JSON.stringify({event:'database_idle_connection_error',code:(error as {code?:string}).code??'UNKNOWN'})));
 return pool;
}
export async function transaction<T>(pool:pg.Pool,fn:(db:pg.PoolClient)=>Promise<T>):Promise<T>{const db=await pool.connect();try{await db.query('begin');const value=await fn(db);await db.query('commit');return value;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
