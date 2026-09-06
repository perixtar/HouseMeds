import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {buildAgentCodexConfig,buildAgentModelCatalog,AGENT_CODEX_VERSION,AGENT_MODEL} from './agent-codex-config.js';
import {agentInstructions,agentOutputSchema,validateAgentAnswer,renderAgentAnswer,type ValidatedAgentAnswer} from './agent-answer.js';
import {validateMcpConfig,type AgentToolRecord} from './agent-mcp.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export interface AgentRunOptions {question:string;apiOrigin:string;apiToken:string;apiKey:string;model?:string;auditRoot?:string;timeoutMs?:number;modelBaseUrl?:string;}
export interface AgentRunResult {status:'completed'|'failed';answer?:ValidatedAgentAnswer;text?:string;run_directory:string;usage?:unknown;error?:string;}
export async function runAgent(options:AgentRunOptions):Promise<AgentRunResult>{
 if(!options.question.trim()||options.question.length>4000)throw Error('QUESTION_MUST_BE_1_TO_4000_CHARACTERS');
 if(!options.apiKey)throw Error('OPENAI_API_KEY_NOT_CONFIGURED');
 if(options.model&&options.model!==AGENT_MODEL)throw Error('MODEL_NOT_VALIDATED');
 validateMcpConfig({apiOrigin:options.apiOrigin,apiToken:options.apiToken});
 const timeout=options.timeoutMs??60000;if(!Number.isInteger(timeout)||timeout<1||timeout>60000)throw Error('INVALID_AGENT_DEADLINE');
 const codexBin=process.env.HOUSEMED_CODEX_BIN??execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim();
 const version=execFileSync(codexBin,['--version'],{encoding:'utf8'}).trim();if(version!=='codex-cli '+AGENT_CODEX_VERSION)throw Error('CODEX_VERSION_NOT_VALIDATED');
 const runId=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
 const runDirectory=resolve(options.auditRoot??join(root,'data/audits/agent'),runId);await mkdir(runDirectory,{recursive:true,mode:0o700});
 const cache=join(root,'.cache');await mkdir(cache,{recursive:true,mode:0o700});const taskRuntimePath=await mkdtemp(join(cache,'agent-runtime-'));
 const cliConfigDirectory=join(taskRuntimePath,'codex'),workspace=join(taskRuntimePath,'workspace');await mkdir(cliConfigDirectory,{mode:0o700});await mkdir(workspace,{mode:0o700});
 const toolLedger=join(runDirectory,'tools.log'),finalPath=join(taskRuntimePath,'answer.json');
 const redact=(text:string)=>text.replaceAll(options.apiKey,'[REDACTED]').replaceAll(options.apiToken,'[REDACTED]').replace(/sk-(?:proj-)?[A-Za-z0-9_-]+/g,'[REDACTED]');
 const started=Date.now();let result:AgentRunResult={status:'failed',run_directory:runDirectory},events:any[]=[],diagnostics='',toolCount=0;
 try{
  const instructionsPath=join(taskRuntimePath,'instructions.txt'),schemaPath=join(taskRuntimePath,'answer-schema.json'),catalogPath=join(taskRuntimePath,'model-catalog.json'),mcpConfigPath=join(taskRuntimePath,'mcp.json');
  await writeFile(instructionsPath,agentInstructions,{mode:0o600});await writeFile(schemaPath,JSON.stringify(agentOutputSchema),{mode:0o600});await writeFile(catalogPath,buildAgentModelCatalog(),{mode:0o600});
  await writeFile(mcpConfigPath,JSON.stringify({apiOrigin:options.apiOrigin,apiToken:options.apiToken,auditPath:toolLedger,maxCalls:8,timeoutMs:10000}),{mode:0o600});
  await writeFile(join(cliConfigDirectory,'config.toml'),buildAgentCodexConfig({instructionsPath,modelCatalogPath:catalogPath,nodePath:process.execPath,tsxLoaderPath:join(root,'node_modules/tsx/dist/loader.mjs'),mcpScriptPath:join(root,'src/agent-mcp.ts'),mcpCwd:workspace,mcpEnv:{HOUSEMED_MCP_CONFIG:mcpConfigPath},...(options.modelBaseUrl?{mockBaseUrl:options.modelBaseUrl}:{})}),{mode:0o600});
  const env:Record<string,string>={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:process.env.HOME??'',CODEX_HOME:cliConfigDirectory,OPENAI_API_KEY:options.apiKey,LANG:'en_US.UTF-8',NO_COLOR:'1'};
  const child=spawn(codexBin,['exec','--strict-config','--skip-git-repo-check','--ephemeral','--ignore-rules','--sandbox','read-only','--json','--color','never','--output-schema',schemaPath,'--output-last-message',finalPath,'--cd',workspace,'-'],{cwd:workspace,env,detached:true,stdio:['pipe','pipe','pipe']});
  let stopReason:string|undefined,pending='';
  const stop=(reason:string)=>{if(stopReason)return;stopReason=reason;try{process.kill(-child.pid!,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},1000).unref();};
  const timer=setTimeout(()=>stop('agent_deadline_exceeded'),timeout);
  const cancel=()=>stop('agent_cancelled');process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  const capture=(line:string)=>{
   if(!line.trim())return;let event:any;try{event=JSON.parse(redact(line));}catch{return;}
   events.push(event);
   if(events.length>300||JSON.stringify(events).length>1500000){stop('agent_event_limit_exceeded');return;}
   const item=event.item;
   if(event.type==='item.started'&&item&&/tool_call|command_execution|file_change|web_search/.test(item.type??'')){
    if(++toolCount>8)stop('agent_tool_limit_exceeded');
    if(/command_execution|file_change|web_search/.test(item.type))stop('unexpected_agent_capability');
   }
  };
  child.stdout.on('data',chunk=>{pending+=chunk.toString();if(pending.length>500000){stop('agent_event_limit_exceeded');return;}let newline;while((newline=pending.indexOf('\n'))>=0){capture(pending.slice(0,newline));pending=pending.slice(newline+1);}});
  child.stderr.on('data',chunk=>{diagnostics=redact((diagnostics+chunk.toString()).slice(-32000));});
  child.stdin.on('error',()=>{});child.stdin.end(options.question);
  let code:number|null;try{code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});}finally{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
  capture(pending);
  const usage=events.findLast(e=>e.type==='turn.completed')?.usage;
  if(stopReason)throw Error(stopReason);if(code!==0)throw Error('codex_execution_failed');
  const selections=JSON.parse(await readFile(finalPath,'utf8'));
  let records:AgentToolRecord[]=[];try{records=(await readFile(toolLedger,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(records.length>8)throw Error('agent_tool_limit_exceeded');
  const answer=validateAgentAnswer(selections,records),text=renderAgentAnswer(answer);
  result={status:'completed',answer,text,run_directory:runDirectory,usage};
 }catch(error){result={status:'failed',run_directory:runDirectory,usage:events.findLast(e=>e.type==='turn.completed')?.usage,error:error instanceof Error?error.message:'agent_execution_failed'};}
 finally{
  try{
  await writeFile(join(runDirectory,'events.log'),events.map(e=>JSON.stringify(e)).join('\n')+'\n',{mode:0o600});await writeFile(join(runDirectory,'diagnostics.log'),redact(diagnostics),{mode:0o600});
  await writeFile(join(runDirectory,'result.json'),redact(JSON.stringify({...result,question:options.question,model:AGENT_MODEL,codex_version:AGENT_CODEX_VERSION,started_at:new Date(started).toISOString(),elapsed_ms:Date.now()-started,tool_calls:toolCount},null,2))+'\n',{mode:0o600});
  }finally{await rm(taskRuntimePath,{recursive:true,force:true});}
 }
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const json=process.argv.includes('--json'),question=process.argv.slice(2).filter(x=>x!=='--json').join(' ');
  const [agentEnv,apiEnv]=await Promise.all([readFile(join(root,'.env.agent'),'utf8').then(parseEnv),readFile(join(root,'.env.api'),'utf8').then(parseEnv)]);
  const result=await runAgent({question,apiOrigin:'http://127.0.0.1:'+(apiEnv.PORT??'63813'),apiToken:apiEnv.HOUSEMED_API_TOKEN??'',apiKey:agentEnv.OPENAI_API_KEY??'',model:agentEnv.HOUSEMED_AGENT_MODEL});
  console.log(json?JSON.stringify(result,null,2):result.status==='completed'?result.text:'HouseMed could not complete this question: '+result.error);if(result.status==='failed')process.exitCode=1;
 }catch(error){console.error((error as NodeJS.ErrnoException).code==='ENOENT'?'Configure the named OpenAI key in .env.agent before running npm run ask.':error instanceof Error?error.message:'Agent setup failed');process.exitCode=1;}
}
