import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,readFile,chmod,rm} from 'node:fs/promises';
import {homedir} from 'node:os';import {resolve} from 'node:path';
const [action='status',selected='all']=process.argv.slice(2);
if(process.platform!=='darwin'||!['install','status','uninstall'].includes(action)||!['api','backup','all'].includes(selected))throw Error('Usage: node scripts/mac-services.mjs install|status|uninstall api|backup|all (macOS only)');
const root=resolve('.'),domain=`gui/${process.getuid()}`,directory=resolve(homedir(),'Library/LaunchAgents');
await mkdir(directory,{recursive:true});await mkdir('data/logs',{recursive:true,mode:0o700});
for(const name of selected==='all'?['api','backup']:[selected]){
 const label='com.housemed.'+name;const path=resolve(directory,label+'.plist');
 const service={Label:label,WorkingDirectory:root,ProgramArguments:[process.execPath,...(name==='api'?['--import','tsx',resolve('src/api.ts')]:[resolve('scripts/backup.mjs')])],StandardOutPath:resolve(`data/logs/${name}.log`),StandardErrorPath:resolve(`data/logs/${name}.error.log`),Umask:63,EnvironmentVariables:{PATH:process.env.PATH},...(name==='api'?{RunAtLoad:true,KeepAlive:true,ThrottleInterval:30}:{StartCalendarInterval:{Hour:3,Minute:15}})};
 const existing=spawnSync('/usr/bin/plutil',['-convert','json','-o','-',path],{encoding:'utf8'});
 if(existing.status===0&&JSON.parse(existing.stdout).WorkingDirectory!==root)throw Error('SERVICE_BELONGS_TO_ANOTHER_WORKSPACE');
 const current=spawnSync('/bin/launchctl',['print',domain+'/'+label],{encoding:'utf8'});
 if(action==='install'){
  if(current.status===0)execFileSync('/bin/launchctl',['bootout',domain+'/'+label]);
  execFileSync('/usr/bin/plutil',['-convert','xml1','-o',path,'-'],{input:JSON.stringify(service)});await chmod(path,0o600);
  execFileSync('/usr/bin/plutil',['-lint',path]);execFileSync('/bin/launchctl',['bootstrap',domain,path]);console.log(JSON.stringify({service:label,installed:true,path}));
 }else if(action==='uninstall'){
  if(current.status===0)execFileSync('/bin/launchctl',['bootout',domain+'/'+label]);await rm(path,{force:true});console.log(JSON.stringify({service:label,installed:false}));
 }else console.log(JSON.stringify({service:label,loaded:current.status===0,state:current.stdout.match(/state = ([^\n]+)/)?.[1]??null,pid:current.stdout.match(/pid = (\d+)/)?.[1]??null}));
}
