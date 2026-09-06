import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {agentToolNames,validateMcpConfig,type AgentToolRecord} from '../src/agent-mcp.js';
import {validateAgentAnswer,renderAgentAnswer} from '../src/agent-answer.js';

const token='test-api-token-'.repeat(4);
test('MCP accepts only an authenticated fixed loopback API and bounded work',()=>{
 for(const apiOrigin of ['https://example.com','http://localhost:63813','http://127.0.0.1/private','http://user:pass@127.0.0.1','http://127.0.0.1/?secret=x'])assert.throws(()=>validateMcpConfig({apiOrigin,apiToken:token}),/LOOPBACK/);
 assert.throws(()=>validateMcpConfig({apiOrigin:'http://127.0.0.1:63813',apiToken:'short'}),/TOKEN/);
 assert.throws(()=>validateMcpConfig({apiOrigin:'http://127.0.0.1:63813',apiToken:token,maxCalls:9}),/LIMIT/);
});
test('actual stdio MCP exposes four read tools, validates arguments, uses GET and records provenance',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'housemed-mcp-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const requests:{method:string|undefined;path:string|undefined;authorization:string|undefined}[]=[];
 const server=createServer((req,res)=>{requests.push({method:req.method,path:req.url,authorization:req.headers.authorization});res.setHeader('content-type','application/json');
  if(req.url?.includes('cursor=99')){res.statusCode=503;res.end(JSON.stringify({secret:'must never be relayed'}));}
  else if(req.url?.includes('cursor=98')){res.statusCode=302;res.setHeader('location','http://example.com');res.end();}
  else res.end(JSON.stringify({items:[],next_cursor:null}));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const port=(server.address() as {port:number}).port,configPath=join(dir,'mcp.json'),auditPath=join(dir,'tools.jsonl');
 await writeFile(configPath,JSON.stringify({apiOrigin:'http://127.0.0.1:'+port,apiToken:token,auditPath,maxCalls:4}),{mode:0o600});
 const client=new Client({name:'housemed-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('src/agent-mcp.ts')],cwd:dir,env:{PATH:process.env.PATH??'',HOUSEMED_MCP_CONFIG:configPath},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});await client.connect(transport);t.after(()=>client.close());
 const listed=await client.listTools();assert.deepEqual(listed.tools.map(x=>x.name).sort(),[...agentToolNames].sort());assert.ok(listed.tools.every(x=>x.annotations?.readOnlyHint&&!x.annotations?.destructiveHint));
 const invalid=await client.callTool({name:'search_catalog',arguments:{q:'metformin',sql:'delete from offers',url:'http://example.com'}});assert.equal(invalid.isError,true);assert.equal(requests.length,0);
 const absent=await client.callTool({name:'execute_sql',arguments:{query:'drop table offers'}});assert.equal(absent.isError,true);assert.equal(requests.length,0);
 const result=await client.callTool({name:'search_catalog',arguments:{q:"x'; DROP TABLE offers;--",source:'healthwarehouse',limit:20}});
 assert.equal(result.isError,false);assert.equal(requests[0].method,'GET');assert.equal(new URL(requests[0].path!,'http://local').pathname,'/v1/listings');assert.equal(requests[0].authorization,'Bearer '+token);
 for(const cursor of ['99','98']){const failed=await client.callTool({name:'search_catalog',arguments:{cursor}});assert.equal(failed.isError,true);assert.ok(JSON.stringify(failed).includes('pricing_service_unavailable'));assert.ok(!JSON.stringify(failed).includes('must never'));}
 await client.callTool({name:'get_source_status',arguments:{}});
 const limited=await client.callTool({name:'get_source_status',arguments:{}});assert.equal(limited.isError,true);assert.ok(JSON.stringify(limited).includes('tool_limit_reached'));assert.equal(requests.length,4);
 const records=(await readFile(auditPath,'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.equal(records.length,5);assert.equal(records[0].status,'ok');assert.equal(records[4].error,'tool_limit_reached');assert.ok(!JSON.stringify(records).includes(token));assert.equal(stderr,'');
});

const now=Date.parse('2026-09-06T01:00:00Z');
const price={offer_id:'12',listing_id:'3',source:'costplus',source_name:'Lisinopril 20mg Tablet',medication_id:'1',match_status:'verified',matching_scope:'reviewed_medication',sold_as:'tablet',content_quantity:'1',content_unit:'tablet',physical_quantity:'30',ordering_quantity:'30',price_cents:'555',currency:'USD',availability:'unknown',purchase_verification_required:true,quote_kind:'estimate',quote_terms:{shipping:null},purchase_url:'https://www.costplusdrugs.com/medications/lisinopril-20mg-tablet/',observed_at:'2026-09-06T00:30:00Z',fresh_until:'2026-09-07T00:30:00Z'};
const record=():AgentToolRecord=>({call_id:'call-one',tool:'get_medication_offers',arguments:{medication_id:'1',quantity:'30',unit:'tablet',include_estimates:true},status:'ok',started_at:'2026-09-06T00:30:00Z',elapsed_ms:1,data:{items:[structuredClone(price)],next_cursor:null}});
const answer=()=>({status:'answer',intent:'prices',catalog_refs:[],offer_refs:[{call_id:'call-one',offer_id:'12'}],source_refs:[],clarify_field:'none',reason:'none'});
test('answer renderer derives exact cents, units, timestamps and estimate warnings from tool records',()=>{
 const validated=validateAgentAnswer(answer(),[record()],now),text=renderAgentAnswer(validated);assert.ok(text.includes('$5.55 for 30 tablet'));assert.ok(text.includes('stock unconfirmed'));assert.ok(text.includes(price.observed_at));assert.ok(text.includes(price.purchase_url));assert.equal(validated.offers[0].price_cents,'555');
 assert.throws(()=>validateAgentAnswer({...answer(),price_cents:'1'},[record()],now));
});
test('invented references, stale quotes, unknown URLs and unapproved estimates are rejected',()=>{
 assert.throws(()=>validateAgentAnswer({...answer(),offer_refs:[{call_id:'invented',offer_id:'12'}]},[record()],now),/REFERENCE/);
 assert.throws(()=>validateAgentAnswer({...answer(),offer_refs:[{call_id:'call-one',offer_id:'999'}]},[record()],now),/REFERENCE/);
 for(const patch of [{fresh_until:'2026-09-05T00:00:00Z'},{price_cents:'5.55'},{currency:'EUR'}]){const r=record();Object.assign(r.data.items[0],patch);assert.throws(()=>validateAgentAnswer(answer(),[r],now),/QUOTE_NOT_CURRENT/);}
 const r=record();r.arguments.include_estimates=false;assert.throws(()=>validateAgentAnswer(answer(),[r],now),/AVAILABILITY/);
 const foreign=record();foreign.data.items[0].purchase_url='https://example.com';assert.throws(()=>validateAgentAnswer(answer(),[foreign],now),/SOURCE_URL/);
});
test('unmatched source prices cannot be relabeled as verified cross-source comparisons',()=>{
 const r=record();r.tool='get_listing_prices';r.data.items[0].match_status='unmatched';r.data.items[0].matching_scope='source_listing_only';r.data.items[0].medication_id=null;
 const verified=validateAgentAnswer(answer(),[r],now);assert.ok(renderAgentAnswer(verified).includes('Source listing only; cross-source identity unmatched'));
 r.tool='get_medication_offers';assert.throws(()=>validateAgentAnswer(answer(),[r],now),/COMPARABLE/);
 r.tool='get_listing_prices';r.data.items[0].match_status='needs_review';assert.throws(()=>validateAgentAnswer(answer(),[r],now),/SCOPE/);
});
test('no-results and service failures require tool evidence; refusals cannot include price facts',()=>{
 const empty={...answer(),status:'not_found',reason:'no_results',offer_refs:[]};assert.throws(()=>validateAgentAnswer(empty,[],now),/NO_RESULTS/);
 const r=record();r.data.items=[];assert.equal(validateAgentAnswer(empty,[r],now).status,'not_found');
 const failure={...empty,status:'unavailable',reason:'tool_failure'};assert.throws(()=>validateAgentAnswer(failure,[],now),/UNAVAILABLE/);r.status='error';r.error='pricing_service_unavailable';assert.equal(validateAgentAnswer(failure,[r],now).status,'unavailable');
 assert.throws(()=>validateAgentAnswer({...answer(),status:'declined',reason:'clinical_question'},[record()],now),/FACTS/);
});
