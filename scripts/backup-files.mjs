import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

export const artifactRoots=['data/evidence','data/manifests','data/audits','data/reports'];
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateArtifactPath(path){
 if(typeof path!=='string'||!artifactRoots.some(root=>path.startsWith(root+'/'))||
  path.split('/').some(part=>!part||part==='.'||part==='..'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))||
  !/\.(json|png|txt|log)$/.test(path))throw Error('UNSAFE_BACKUP_ARTIFACT_PATH');
 return path;
}
export async function collectArtifacts(workspace){
 const files=[];
 try{if((await lstat(resolve(workspace,'data'))).isSymbolicLink())throw Error('BACKUP_SYMLINK_NOT_ALLOWED');}catch(error){if(error.code!=='ENOENT')throw error;}
 async function visit(path,optional=false){
  let stat;try{stat=await lstat(resolve(workspace,path));}catch(error){if(optional&&error.code==='ENOENT')return;throw error;}
  if(stat.isSymbolicLink())throw Error('BACKUP_SYMLINK_NOT_ALLOWED');
  if(stat.isDirectory()){
   for(const entry of (await readdir(resolve(workspace,path))).sort())await visit(path+'/'+entry);
  }else if(stat.isFile()){
   validateArtifactPath(path);const bytes=await readFile(resolve(workspace,path)),sha256=digest(bytes);
   const contentHash=path.match(/\/[a-f0-9]{20}-([a-f0-9]{64})\.json$/)?.[1];
   if(contentHash&&contentHash!==sha256)throw Error('EVIDENCE_CHECKSUM_MISMATCH');
   files.push({path,sha256,encoding:'base64',body:bytes.toString('base64')});
  }else throw Error('BACKUP_NON_REGULAR_FILE');
 }
 for(const root of artifactRoots)await visit(root,true);
 return files;
}
export function decodeArtifactFiles(snapshot){
 let files;
 if(snapshot.format==='housemed-logical-backup-v3')files=snapshot.files;
 else if(snapshot.format==='housemed-logical-backup-v2'){
  if(!Array.isArray(snapshot.evidence))throw Error('INVALID_BACKUP_FILES');
  files=snapshot.evidence.map(file=>({...file,path:'data/evidence/'+file.path,encoding:'utf8'}));
 }
 else throw Error('UNSUPPORTED_BACKUP_FORMAT');
 if(!Array.isArray(files))throw Error('INVALID_BACKUP_FILES');
 const seen=new Set();
 return files.map(file=>{
  validateArtifactPath(file.path);if(seen.has(file.path))throw Error('DUPLICATE_BACKUP_ARTIFACT');seen.add(file.path);
  if(typeof file.body!=='string'||!['base64','utf8'].includes(file.encoding)||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('INVALID_BACKUP_ARTIFACT');
  const bytes=Buffer.from(file.body,file.encoding);
  if(file.encoding==='base64'&&bytes.toString('base64')!==file.body)throw Error('INVALID_BACKUP_ENCODING');
  if(digest(bytes)!==file.sha256)throw Error('BACKUP_ARTIFACT_CHECKSUM_MISMATCH');
  return {path:file.path,sha256:file.sha256,bytes};
 });
}
export function checkEvidenceReferences(value,files){
 const archived=new Set(files.map(file=>file.path));
 function visit(value){
  if(typeof value==='string'&&/^(?:storage:\/\/housemed-evidence\/|local:\/\/)/.test(value)){
   const path='data/evidence/'+value.replace(/^(?:storage:\/\/housemed-evidence\/|local:\/\/)/,'');
   if(!archived.has(path))throw Error('BACKUP_MISSING_REFERENCED_EVIDENCE');
  }else if(Array.isArray(value))value.forEach(visit);
  else if(value&&typeof value==='object')Object.values(value).forEach(visit);
 }
 visit(value);
}
export async function restoreArtifacts(directory,files){
 // Caller provides a newly-created private directory. Validate the complete archive
 // before writing so a malicious later entry cannot cause partial unsafe extraction.
 for(const file of files)validateArtifactPath(file.path);
 for(const file of files){
  const target=resolve(directory,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});
  await writeFile(target,file.bytes,{flag:'wx',mode:0o600});
  if(digest(await readFile(target))!==file.sha256)throw Error('RESTORED_ARTIFACT_MISMATCH');
 }
}
