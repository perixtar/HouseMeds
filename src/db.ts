import pg from 'pg';
import {readFileSync,existsSync} from 'node:fs';

export function makePool(readOnly=false):pg.Pool {
 const file=readOnly?'.env.api':'.env.worker';if(existsSync(file))process.loadEnvFile(file);
 const connectionString=process.env[readOnly?'READ_DATABASE_URL':'DATABASE_URL'];
 if(!connectionString)throw Error('DATABASE_NOT_CONFIGURED');
 return new pg.Pool({connectionString,max:readOnly?4:2,connectionTimeoutMillis:15000,idleTimeoutMillis:30000,ssl:/localhost|127\.0\.0\.1/.test(new URL(connectionString).hostname)?false:{rejectUnauthorized:true,ca:readFileSync('config/supabase-ca.crt','utf8')},application_name:readOnly?'housemed-api':'housemed-worker'});
}
export async function transaction<T>(pool:pg.Pool,fn:(db:pg.PoolClient)=>Promise<T>):Promise<T>{const db=await pool.connect();try{await db.query('begin');const value=await fn(db);await db.query('commit');return value;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
