import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {collectArtifacts,decodeArtifactFiles,checkEvidenceReferences,restoreArtifacts,digest} from '../scripts/backup-files.mjs';
const file=(path,body='{}')=>({path,body:Buffer.from(body).toString('base64'),encoding:'base64',sha256:digest(body)});
async function workspace(t){const path=await mkdtemp(join(tmpdir(),'housemed-backup-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function put(root,path,body){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),body);}
test('backup covers numeric extracts, nonnumeric browser evidence, manifests and audits without copying secrets or backups',async t=>{
 const root=await workspace(t),image=Buffer.from([137,80,78,71,0,255]);
 const input=new Map([
  [`data/evidence/healthwarehouse/42/${'a'.repeat(20)}-${digest('{}')}.json`,'{}'],
  ['data/evidence/costplus/coverage-audit-20260905/page.json','{"observed":true}'],
  ['data/evidence/access/costplus/page.png',image],
  ['data/evidence/access/costplus/page.txt','Rendered € evidence'],
  ['data/manifests/e2e-live.json','{"listings":[]}'],
  ['data/audits/e2e/run-1/browser.json','{"verified":true}'],
  ['data/audits/e2e/run-1/collector.log','{"run":"succeeded"}'],
  ['data/reports/e2e-browser.json','{"checks":1}']
 ]);
 for(const [path,bytes] of input)await put(root,path,bytes);
 await put(root,'.env.worker','secret');await put(root,'config/secrets.json','secret');await put(root,'data/backups/old.json','old backup');
 const archived=await collectArtifacts(root);assert.equal(archived.length,input.size);
 const decoded=decodeArtifactFiles({format:'housemed-logical-backup-v3',files:archived});
 const restored=await workspace(t);await restoreArtifacts(restored,decoded);
 for(const [path,bytes] of input)assert.deepEqual(await readFile(join(restored,path)),Buffer.from(bytes));
 assert.ok(decoded.every(entry=>input.has(entry.path)));
 checkEvidenceReferences({run:{evidence_path:'storage://housemed-evidence/costplus/coverage-audit-20260905/page.json'}},decoded);
 assert.throws(()=>checkEvidenceReferences({path:'local://costplus/missing/page.json'},decoded),/MISSING_REFERENCED_EVIDENCE/);
});
test('artifact collection rejects symlinks and corrupted content-addressed extracts',async t=>{
 const root=await workspace(t);await put(root,'data/audits/good.json','{}');await symlink(join(root,'data/audits/good.json'),join(root,'data/audits/link.json'));
 await assert.rejects(collectArtifacts(root),/SYMLINK_NOT_ALLOWED/);
 await rm(join(root,'data/audits/link.json'));await put(root,`data/evidence/costplus/42/${'a'.repeat(20)}-${'b'.repeat(64)}.json`,'{}');
 await assert.rejects(collectArtifacts(root),/EVIDENCE_CHECKSUM_MISMATCH/);
 const outer=await workspace(t);await symlink(join(root,'data'),join(outer,'data'));await assert.rejects(collectArtifacts(outer),/SYMLINK_NOT_ALLOWED/);
});
test('archive decoder rejects traversal, absolute paths, duplicate entries, corrupt hashes and noncanonical base64',()=>{
 const decode=files=>decodeArtifactFiles({format:'housemed-logical-backup-v3',files});
 for(const path of ['/tmp/exfil.json','data/audits/../../.env','data/audits/../reports/x.json','data/audits/a\\b.json','data/audits//x.json','data/audits/%2e%2e/x.json','data/backups/x.json','.env.worker'])assert.throws(()=>decode([file(path)]),/UNSAFE_BACKUP_ARTIFACT_PATH/);
 const a=file('data/audits/a.json');assert.throws(()=>decode([a,a]),/DUPLICATE_BACKUP_ARTIFACT/);
 assert.throws(()=>decode([{...a,sha256:'b'.repeat(64)}]),/CHECKSUM_MISMATCH/);
 assert.throws(()=>decode([{...a,body:a.body+'\n'}]),/INVALID_BACKUP_ENCODING/);
});
test('legacy v2 UTF-8 source evidence remains restorable with its original checksum',async t=>{
 const body='{"source":"café"}',path=`costplus/42/${'a'.repeat(20)}-${digest(body)}.json`;
 const files=decodeArtifactFiles({format:'housemed-logical-backup-v2',evidence:[{path,body,sha256:digest(body)}]});
 checkEvidenceReferences({evidence:'local://'+path},files);const restored=await workspace(t);await restoreArtifacts(restored,files);
 assert.equal(await readFile(join(restored,'data/evidence',path),'utf8'),body);
});
test('unsafe extraction input is rejected before any file is written',async t=>{
 const restored=await workspace(t),safe={path:'data/audits/good.json',bytes:Buffer.from('{}'),sha256:digest('{}')};
 await assert.rejects(restoreArtifacts(restored,[safe,{...safe,path:'../outside.json'}]),/UNSAFE_BACKUP_ARTIFACT_PATH/);
 assert.deepEqual(await readdir(restored),[]);
});
