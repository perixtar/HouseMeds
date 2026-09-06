import {existsSync,mkdirSync,chmodSync} from 'node:fs';import {resolve} from 'node:path';import {execFileSync} from 'node:child_process';
const bin=process.env.PG_BIN??'/opt/homebrew/opt/postgresql@17/bin';
if(!existsSync(bin+'/initdb'))throw Error('PostgreSQL 17 is required for database tests. Set PG_BIN or install postgresql@17.');
const data=resolve('.cache/pg-test'),socket=resolve('.cache/pgsock');mkdirSync(socket,{recursive:true});chmodSync(socket,0o700);
if(!existsSync(data+'/PG_VERSION'))execFileSync(bin+'/initdb',['-D',data,'--auth-local=trust','--auth-host=scram-sha-256','--no-instructions'],{stdio:'pipe'});
try{execFileSync(bin+'/pg_ctl',['-D',data,'status'],{stdio:'pipe'});}catch{execFileSync(bin+'/pg_ctl',['-D',data,'-l',resolve('.cache/pg-test.log'),'-o',`-k ${socket} -h "" -p 65431`,'start'],{stdio:'pipe'});}
console.log('Isolated PostgreSQL test cluster ready (local Unix socket only).');
