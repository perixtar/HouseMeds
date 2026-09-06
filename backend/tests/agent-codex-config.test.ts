import test from 'node:test';import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';import {createRequire} from 'node:module';
import {AGENT_CODEX_VERSION,AGENT_MODEL,HOUSEMED_READ_TOOLS,buildAgentCodexConfig,buildAgentModelCatalog,type AgentCodexConfigOptions} from '../src/agent-codex-config.js';
const require=createRequire(import.meta.url);
const options:AgentCodexConfigOptions={instructionsPath:'/tmp/instructions.md',modelCatalogPath:'/tmp/models.json',nodePath:process.execPath,tsxLoaderPath:require.resolve('tsx'),mcpScriptPath:resolve('src/agent-mcp.ts'),mcpCwd:'/tmp',mcpEnv:{HOUSEMED_MCP_CONFIG:'/tmp/mcp.json'}};
test('agent config fixes model/tool scope and only passes the private MCP config path to its child',()=>{
 const config=buildAgentCodexConfig(options),catalog=JSON.parse(buildAgentModelCatalog());
 assert.ok(config.includes('env_key = "OPENAI_API_KEY"'));assert.ok(config.includes('https://api.openai.com/v1'));
 assert.ok(config.includes('enabled_tools = '+JSON.stringify(HOUSEMED_READ_TOOLS)));
 assert.equal(catalog.models[0].slug,AGENT_MODEL);assert.equal(catalog.models[0].apply_patch_tool_type,null);assert.equal(catalog.models[0].supports_search_tool,false);
 assert.throws(()=>buildAgentCodexConfig({...options,mcpCwd:'relative'}),/ABSOLUTE_PATH/);
 assert.throws(()=>buildAgentCodexConfig({...options,mockBaseUrl:'https://example.com/v1'}),/LOOPBACK/);
 assert.throws(()=>buildAgentCodexConfig({...options,mcpEnv:{...options.mcpEnv,OPENAI_API_KEY:'leak'} as any}),/MCP_ENV_NOT_ALLOWED/);
});
async function listen(server:Server):Promise<string>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+(server.address() as {port:number}).port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
test('real pinned Codex exposes only HouseMed business tools plus inert MCP helpers and rejects file/exec/resource attempts',{timeout:30000},async t=>{
 const binary=process.env.HOUSEMED_TEST_CODEX_BIN??'/Applications/ChatGPT.app/Contents/Resources/codex';
 const version=spawnSync(binary,['--version'],{encoding:'utf8',timeout:5000});
 if(version.error&&'code' in version.error&&version.error.code==='ENOENT'){t.skip('Install the pinned Codex CLI to run its outbound-capability check');return;}
 assert.equal(version.status,0);assert.equal(version.stdout.trim(),'codex-cli '+AGENT_CODEX_VERSION);
 const root=await mkdtemp(join(tmpdir(),'housemed-agent-capability-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'codex-home'),cwd=join(root,'work');await mkdir(home);await mkdir(cwd);
 const apiToken='fixture_housemed_private_token_1234567890',privateMarker='PRIVATE_FILE_CONTENT_MUST_NOT_REACH_MODEL',privatePath=join(root,'private-secret.txt'),writeTarget=join(cwd,'forbidden-write.txt');
 await writeFile(privatePath,privateMarker,{mode:0o600});
 const apiCalls:{method:string|undefined;url:string|undefined}[]=[];
 const api=createServer((req,res)=>{apiCalls.push({method:req.method,url:req.url});assert.equal(req.headers.authorization,'Bearer '+apiToken);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({as_of:'2026-09-06T00:00:00Z',sources:[{source:'healthwarehouse',fresh_eligible_offers:1}]}));});
 const apiOrigin=await listen(api);t.after(()=>close(api));
 const captured:any[]=[];
 const model=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);captured.push(JSON.parse(Buffer.concat(chunks).toString()));const round=captured.length;
  const call=(name:string,args:unknown,namespace?:string,suffix='')=>({type:'function_call',id:'fc_'+round+'_'+name+suffix,call_id:'call_'+round+'_'+name+suffix,name,arguments:JSON.stringify(args),...(namespace?{namespace}:{})});
  let output:any[];
  if(round===1)output=[call('list_mcp_resources',{server:'housemed'}),call('list_mcp_resource_templates',{server:'housemed'})];
  else if(round===2)output=[call('read_mcp_resource',{server:'housemed',uri:'file://'+privatePath}),call('read_mcp_resource',{server:'other_server',uri:'file://'+privatePath},undefined,'_other')];
  else if(round===3)output=[call('exec_command',{cmd:'/usr/bin/touch '+writeTarget}),{type:'custom_tool_call',id:'patch_3',call_id:'patch_3',name:'apply_patch',input:'*** Begin Patch\n*** Add File: '+writeTarget+'\n+forbidden\n*** End Patch\n'}];
  else if(round===4)output=[call('get_source_status',{},'mcp__housemed')];
  else output=[{type:'message',id:'msg_final',role:'assistant',content:[{type:'output_text',text:'Capability probe complete.',annotations:[]}]}];
  const events=[{type:'response.created',response:{id:'resp_'+round,status:'in_progress',output:[]}},...output.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),{type:'response.completed',response:{id:'resp_'+round,status:'completed',output,usage:{input_tokens:10,output_tokens:3,total_tokens:13}}}];
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''));
 });
 const mockBaseUrl=await listen(model);t.after(()=>close(model));
 const instructionsPath=join(root,'instructions.md'),modelCatalogPath=join(root,'models.json'),mcpConfigPath=join(root,'mcp.json'),auditPath=join(root,'audit.jsonl');
 await writeFile(instructionsPath,'You are the HouseMed read-only pricing assistant. Use only HouseMed tools; no clinical advice.');await writeFile(modelCatalogPath,buildAgentModelCatalog());
 await writeFile(mcpConfigPath,JSON.stringify({apiOrigin,apiToken,auditPath,maxCalls:8,timeoutMs:10000}),{mode:0o600});
 await writeFile(join(home,'config.toml'),buildAgentCodexConfig({...options,instructionsPath,modelCatalogPath,mcpCwd:cwd,mcpEnv:{HOUSEMED_MCP_CONFIG:mcpConfigPath},mockBaseUrl}),{mode:0o600});
 const child=spawn(binary,['exec','--strict-config','--skip-git-repo-check','--ephemeral','--ignore-rules','--json','-C',cwd,'Read source status.'],{env:{PATH:process.env.PATH,CODEX_HOME:home,OPENAI_API_KEY:'fixture-openai-key'},stdio:['pipe','pipe','pipe']});
 child.stdin.end();let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 const timer=setTimeout(()=>child.kill('SIGKILL'),20000);const code=await new Promise<number|null>(resolve=>child.on('close',resolve));clearTimeout(timer);
 assert.equal(code,0,stderr+'\n'+stdout);assert.equal(captured.length,5);
 const helpers=['list_mcp_resource_templates','list_mcp_resources','read_mcp_resource'];
 for(const request of captured){
  assert.equal(request.model,AGENT_MODEL);assert.equal(request.store,false);
  assert.deepEqual(request.tools.filter((tool:any)=>tool.type==='function').map((tool:any)=>tool.name).sort(),helpers);
  const business=request.tools.find((tool:any)=>tool.type==='namespace'&&tool.name==='mcp__housemed');assert.ok(business);
  assert.deepEqual(business.tools.map((tool:any)=>tool.name).sort(),[...HOUSEMED_READ_TOOLS].sort());assert.equal(request.tools.length,4);
 }
 const inputs=captured.flatMap(request=>request.input??[]),outputs=inputs.filter((item:any)=>item.type==='function_call_output'||item.type==='custom_tool_call_output');
 const text=JSON.stringify(captured);assert.ok(!text.includes(apiToken));assert.ok(!text.includes(privateMarker));assert.ok(!text.includes('fixture-openai-key'));
 assert.ok(outputs.some((item:any)=>item.call_id==='call_1_list_mcp_resources'&&/resources/.test(JSON.stringify(item.output))));
 assert.ok(outputs.some((item:any)=>item.call_id==='call_2_read_mcp_resource'&&/error|unknown|not found|does not support/i.test(JSON.stringify(item.output))));
 assert.ok(outputs.some((item:any)=>item.call_id==='call_2_read_mcp_resource_other'&&/unknown.*server|server.*unknown|not found/i.test(JSON.stringify(item.output))));
 assert.ok(outputs.some((item:any)=>item.call_id==='call_3_exec_command'&&/unsupported|unknown|not found/i.test(JSON.stringify(item.output))));
 assert.ok(outputs.some((item:any)=>item.call_id==='patch_3'&&/unsupported|unknown|not found/i.test(JSON.stringify(item.output))));
 await assert.rejects(access(writeTarget));assert.deepEqual(apiCalls,[{method:'GET',url:'/v1/sources/status'}]);
 const ledger=(await readFile(auditPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(ledger.length,1);assert.equal(ledger[0].tool,'get_source_status');assert.equal(ledger[0].status,'ok');
 if(process.env.HOUSEMED_CAPABILITY_REPORT){
  await writeFile(process.env.HOUSEMED_CAPABILITY_REPORT,JSON.stringify({status:'passed',verified_at:new Date().toISOString(),cli_version:AGENT_CODEX_VERSION,model:AGENT_MODEL,
   live_model_used:false,model_responses:'local deterministic Responses API mock',outbound_requests:captured.length,response_storage:false,
   business_tools:HOUSEMED_READ_TOOLS,protocol_helpers:helpers,other_model_tools:[],
   checks:{strict_config_accepted:true,model_snapshot_preserved:true,resource_lists_inert:true,private_file_uri_rejected:true,unknown_server_rejected:true,
    forced_exec_rejected:true,forced_patch_rejected:true,no_file_created:true,api_token_not_in_model_context:true,private_file_contents_not_in_model_context:true,allowed_business_tool_reaches_get_api:true},
   api_calls:apiCalls,ledger_calls:ledger.length,
   limitations:['Three generic MCP resource helpers remain registered by Codex; with only this tools-only server they provide no resource/filesystem access.',
    'This validates installed CLI capability isolation and tool dispatch, not paid-model availability, reasoning quality, or clinical correctness.',
    'The model catalog capability override and skip_host_skill_discovery feature are version-sensitive; the runner must require the pinned CLI and rerun this test before upgrades.',
    'The trusted MCP process and Codex runtime still read their configuration and write private runtime/audit files; read-only refers to model capabilities and pricing API operations.']},null,2),{mode:0o600});
 }
});
