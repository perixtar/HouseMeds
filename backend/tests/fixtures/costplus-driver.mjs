import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {SourceClient} from '../../src/sources.ts';import {EvidenceStore} from '../../src/evidence.ts';import {CP_API} from '../../src/core.ts';
const conn=new URL(process.env.DATABASE_URL);assert.equal(conn.pathname,'/housemed_test');assert.equal(conn.searchParams.get('host'),resolve('.cache/pgsock'));
const [file]=process.argv.slice(2);const fixture=JSON.parse(await readFile(new URL('./costplus-lisinopril-api.json',import.meta.url),'utf8'));
SourceClient.prototype.init=async()=>{throw Error('WEBSITE_MUST_NOT_BE_REQUESTED');};SourceClient.prototype.open=async()=>{throw Error('WEBSITE_MUST_NOT_BE_OPENED');};
SourceClient.prototype.json=async function(url){return structuredClone(url===CP_API?fixture.responses[0].response:fixture.responses.find(x=>x.request_url===url).response);};
EvidenceStore.prototype.put=async()=> 'local://test-only-costplus-api.json';
process.argv=[process.execPath,'src/cli.ts','collect','costplus','--manifest',file,'--access-test','--fresh'];await import('../../src/cli.ts');
