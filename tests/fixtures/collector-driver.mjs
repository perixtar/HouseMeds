import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {SourceClient,SourceAccessError} from '../../src/sources.ts';import {EvidenceStore} from '../../src/evidence.ts';
const conn=new URL(process.env.DATABASE_URL);assert.equal(conn.pathname,'/housemed_test');assert.equal(conn.searchParams.get('host'),resolve('.cache/pgsock'));
const [file,mode='success']=process.argv.slice(2);const fixture=JSON.parse(await readFile(new URL('./healthwarehouse-lisinopril.json',import.meta.url),'utf8'));
SourceClient.prototype.init=async()=>{};
SourceClient.prototype.open=async function(url){if(mode==='blocked')throw new SourceAccessError('SOURCE_BLOCKED');const s=structuredClone(fixture.snapshot);s.url=url;s.panel=s.panel.replace(s.product.sku,'CLI-TEST');s.product.sku='CLI-TEST';return s;};
EvidenceStore.prototype.put=async()=> 'local://test-only-cli-evidence.json';
process.argv=[process.execPath,'src/cli.ts','collect','healthwarehouse','--manifest',file,'--access-test','--fresh'];
await import('../../src/cli.ts');
