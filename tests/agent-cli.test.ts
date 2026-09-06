import test from 'node:test';import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';import {mkdtemp,rm,readFile,readdir,mkdir,access} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {runAgent} from '../src/agent-cli.js';
async function listen(server:Server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+(server.address() as {port:number}).port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
function toolResult(value:any):any{
 if(typeof value==='string'){const marker=value.indexOf('\nOutput:\n');try{return toolResult(JSON.parse(marker>=0?value.slice(marker+9):value));}catch{return undefined;}}
 if(value?.call_id&&value?.data)return value;
 if(value&&typeof value==='object')for(const child of Object.values(value)){const found=toolResult(child);if(found)return found;}
}
function respond(res:any,id:number,output:any[]){const events=[{type:'response.created',response:{id:'r'+id,status:'in_progress',output:[]}},...output.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),{type:'response.completed',response:{id:'r'+id,status:'completed',output,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}}];res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));}
test('CLI runner completes actual Codex to MCP to HTTP with validated references and no credential leakage',{timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'housemed-agent-runner-'));t.after(()=>rm(dir,{recursive:true,force:true}));const apiToken='private-housemed-test-token-'.repeat(2),apiKey='fixture-provider-secret';
 const fixture={listing_id:'7',source:'healthwarehouse',source_name:'Metformin 500mg Tablets',brand_name:null,purchase_url:'https://www.healthwarehouse.com/metformin-500mg-tablets',sold_as:'tablet',content_quantity:'1',content_unit:'tablet',match_status:'unmatched',medication_id:null,medication:null};let apiCalls=0;
 const api=createServer((req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/v1/listings?q=metformin');assert.equal(req.headers.authorization,'Bearer '+apiToken);apiCalls++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({items:[fixture],next_cursor:null}));});const apiOrigin=await listen(api);t.after(()=>close(api));
 let rounds=0;const model=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.headers.authorization,'Bearer '+apiKey);assert.ok(!JSON.stringify(request).includes(apiToken));
  if(++rounds===1)respond(res,rounds,[{type:'function_call',id:'f1',call_id:'c1',namespace:'mcp__housemed',name:'search_catalog',arguments:JSON.stringify({q:'metformin'})}]);
  else{const evidence=toolResult(request.input);if(!evidence){res.writeHead(500);res.end("mock missing tool result");return;}respond(res,rounds,[{type:'message',id:'m2',role:'assistant',content:[{type:'output_text',text:JSON.stringify({status:'answer',intent:'catalog',catalog_refs:[{call_id:evidence.call_id,listing_id:'7'}],offer_refs:[],source_refs:[],clarify_field:'none',reason:'none'}),annotations:[]}]}]);}
 });const modelBaseUrl=await listen(model);t.after(()=>close(model));
 const result=await runAgent({question:'Find metformin in the collected catalog.',apiOrigin,apiToken,apiKey,modelBaseUrl,auditRoot:dir,timeoutMs:15000});assert.equal(result.status,'completed',result.error+' '+await readFile(join(result.run_directory,'diagnostics.log'),'utf8')+' '+await readFile(join(result.run_directory,'events.log'),'utf8')); assert.equal(rounds,2);assert.equal(apiCalls,1);assert.equal(result.answer?.catalog[0].listing_id,'7');assert.ok(result.text?.includes('unmatched'));assert.ok(result.text?.includes('does not confirm pharmacy stock'));
 const report=await readFile(join(result.run_directory,'result.json'),'utf8'),events=await readFile(join(result.run_directory,'events.log'),'utf8');assert.ok(!report.includes(apiToken)&&!report.includes(apiKey)&&!events.includes(apiToken)&&!events.includes(apiKey));
});
test('CLI deadline stops stalled model work and produces an explicit failure',{timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'housemed-agent-deadline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const server=createServer(()=>{});const modelBaseUrl=await listen(server);t.after(()=>close(server));
 const start=Date.now(),result=await runAgent({question:'Read source status.',apiOrigin:'http://127.0.0.1:63813',apiToken:'test-api-token-'.repeat(4),apiKey:'fixture-provider-secret',modelBaseUrl,auditRoot:dir,timeoutMs:1000});
 assert.equal(result.status,'failed');assert.equal(result.error,'agent_deadline_exceeded');assert.ok(Date.now()-start<7000);
});
test('private runtime credentials are removed even when final audit persistence fails',{timeout:20000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'housemed-audit-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));let runtime='';
 const server=createServer(async(req,res)=>{
  for await(const chunk of req){};
  const run=(await readdir(dir))[0];assert.ok(run);const auditPath=join(dir,run,'tools.log');
  for(const entry of await readdir(resolve('.cache'))){
   if(!entry.startsWith('agent-runtime-'))continue;
   const candidate=resolve('.cache',entry);let config:any;try{config=JSON.parse(await readFile(join(candidate,'mcp.json'),'utf8'));}catch{continue;}
   if(config.auditPath===auditPath){runtime=candidate;break;}
  }
  assert.ok(runtime);await mkdir(join(dir,run,'events.log'));
  respond(res,1,[{type:'message',id:'m1',role:'assistant',content:[{type:'output_text',text:JSON.stringify({status:'declined',intent:'other',catalog_refs:[],offer_refs:[],source_refs:[],clarify_field:'none',reason:'out_of_scope'}),annotations:[]}]}]);
 });const modelBaseUrl=await listen(server);t.after(()=>close(server));
 await assert.rejects(runAgent({question:'Modify the database.',apiOrigin:'http://127.0.0.1:63813',apiToken:'test-api-token-'.repeat(4),apiKey:'fixture-provider-secret',modelBaseUrl,auditRoot:dir,timeoutMs:10000}),{code:'EISDIR'});
 assert.ok(runtime);await assert.rejects(access(runtime),{code:'ENOENT'});
});
