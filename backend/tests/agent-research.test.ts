import test from 'node:test';import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMcpExpressApp} from '@modelcontextprotocol/sdk/server/express.js';
import {z} from 'zod';
import {buildResearchAgentCodexConfig,buildResearchAgentModelCatalog,EXA_MCP_URL,EXA_READ_TOOLS} from '../src/agent-codex-config.js';
import {buildMedicationResearchPrompt,medicationResearchInstructions,medicationResearchSchema,runMedicationResearch,validateMedicationResearch} from '../src/agent-research.js';

const request={medicine:'Atorvastatin',targetPharmacies:['Amazon Pharmacy'],location:'no location/public national price',targetQuantities:['every quantity explicitly offered']};
function fixture():any{return {
 query:{medicine:'Atorvastatin',target_pharmacies:['Amazon Pharmacy'],location:request.location,target_quantities:request.targetQuantities},
 medications:[{
  canonical_name:'atorvastatin calcium 10 MG Oral Tablet',generic_name:'atorvastatin',brand_name:null,
  ingredients:[{name:'atorvastatin',strength_numerator:'10',strength_numerator_unit:'mg',strength_denominator:null,strength_denominator_unit:null,ingredient_rxcui:'83367'}],
  display_strength:'10 mg',form:'tablet',route:'oral',release_type:'conventional release',rxnorm_rxcui:'617312',rxnorm_term_type:'SCD',
  identity_evidence_urls:['https://dailymed.nlm.nih.gov/example'],listings:[{
   source:'Amazon Pharmacy',source_product_key:'B000000001',source_listing_name:'ATORVASTATIN 10 MG TAB',listing_url:'https://pharmacy.amazon.com/dp/B000000001',
   brand_name:null,manufacturer:null,ndc:null,sold_as:'tablet',content_quantity:'1',content_unit:'tablet',package_description:'30 tablets',prescription_required:true,
   match_status:'verified',match_notes:'Identity fields agree with the cited source.',offers:[{
    ordering_quantity:'30',physical_quantity:'30',content_unit:'tablet',price_cents:'1299',currency:'USD',derived_price_per_unit_cents:null,
    program:'public_cash',membership_required:false,seller:'Amazon Pharmacy',location:request.location,availability:'in_stock',shipping_fee_cents:null,dispensing_fee_cents:null,
    other_terms:[],observed_at_utc:'2026-09-12T20:00:00Z',valid_until:null,evidence_url:'https://pharmacy.amazon.com/dp/B000000001',
    evidence_description:'The first-party page displayed 30 tablets for $12.99.',verification_status:'observed'
   }]
  }]
 }],
 coverage:{pharmacies_requested:99,pharmacies_with_verified_listings:99,verified_offer_count:99,missing_or_blocked_sources:[]},warnings:[]
};}

test('research config exposes only the two bounded Exa read tools and references the key by environment name',()=>{
 const config=buildResearchAgentCodexConfig({instructionsPath:'/tmp/instructions.md',modelCatalogPath:'/tmp/models.json'});
 assert.ok(config.includes(`url = ${JSON.stringify(EXA_MCP_URL)}`));
 assert.ok(config.includes(`enabled_tools = ${JSON.stringify(EXA_READ_TOOLS)}`));
 assert.ok(config.includes('"x-api-key" = "EXA_API_KEY"'));
 assert.ok(!config.includes('[mcp_servers.housemed]'));
 const catalog=JSON.parse(buildResearchAgentModelCatalog());assert.equal(catalog.models[0].supports_search_tool,false);assert.equal(catalog.models[0].apply_patch_tool_type,null);
});

test('research prompt preserves the requested medicine and forbids estimated prices',()=>{
 const prompt=buildMedicationResearchPrompt(request,new Date('2026-09-12T20:00:00Z'));
 assert.match(prompt,/"medicine":"Atorvastatin"/);assert.match(prompt,/Amazon Pharmacy/);assert.match(medicationResearchInstructions,/Never estimate, interpolate, or scale a price/);assert.match(medicationResearchInstructions,/web_search_exa/);
});

test('research validation recomputes coverage and exact price per physical unit',()=>{
 const parsed=validateMedicationResearch(fixture(),request);
 assert.equal(parsed.coverage.pharmacies_requested,1);assert.equal(parsed.coverage.pharmacies_with_verified_listings,1);assert.equal(parsed.coverage.verified_offer_count,1);
 assert.equal(parsed.medications[0]?.listings[0]?.offers[0]?.derived_price_per_unit_cents,'43.3');
 assert.doesNotThrow(()=>medicationResearchSchema.parse(parsed));
});

test('research validation rejects an observed price without an exact physical quantity',()=>{
 const value=fixture();value.medications[0]!.listings[0]!.offers[0]!.physical_quantity=null;
 assert.throws(()=>validateMedicationResearch(value,request),/INCOMPLETE_OBSERVED_OFFER/);
});

async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+(server.address() as {port:number}).port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
function respond(res:any,id:number,output:any[]){const events=[{type:'response.created',response:{id:'r'+id,status:'in_progress',output:[]}},...output.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),{type:'response.completed',response:{id:'r'+id,status:'completed',output,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}}];res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''));}

test('real Codex dispatches an Exa MCP call with the environment-backed API key and returns validated staging data',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'housemed-exa-agent-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const exaKey='fixture-exa-secret',calls:any[]=[];
 const app=createMcpExpressApp();
 app.post('/mcp',async(req:any,res:any)=>{
  assert.equal(req.headers['x-api-key'],exaKey);
  const server=new McpServer({name:'exa-fixture',version:'1.0.0'});
  server.registerTool('web_search_exa',{description:'Search fixture',inputSchema:z.object({query:z.string(),numResults:z.number().optional()})},async args=>{calls.push(args);return {content:[{type:'text',text:'Amazon Pharmacy first-party atorvastatin result'}]};});
  server.registerTool('web_fetch_exa',{description:'Fetch fixture',inputSchema:z.object({urls:z.array(z.string())})},async()=>({content:[{type:'text',text:'Fixture page'}]}));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});await server.connect(transport);await transport.handleRequest(req,res,req.body);
  res.on('close',()=>{void transport.close();void server.close();});
 });
 app.get('/mcp',(_req:any,res:any)=>res.status(405).end());app.delete('/mcp',(_req:any,res:any)=>res.status(405).end());
 const exaServer=await new Promise<Server>(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});t.after(()=>close(exaServer));
 const exaUrl='http://127.0.0.1:'+(exaServer.address() as {port:number}).port+'/mcp';let rounds=0;const captured:any[]=[];
 const model=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());captured.push(body);
  if(++rounds===1)respond(res,rounds,[{type:'function_call',id:'f1',call_id:'c1',namespace:'mcp__exa',name:'web_search_exa',arguments:JSON.stringify({query:'Amazon Pharmacy atorvastatin first-party listing',numResults:1})}]);
  else respond(res,rounds,[{type:'message',id:'m2',role:'assistant',content:[{type:'output_text',text:JSON.stringify(fixture()),annotations:[]}]}]);
 });
 const modelBaseUrl=await listen(model);t.after(()=>close(model));
 const result=await runMedicationResearch({...request,apiKey:'fixture-openai-secret',exaApiKey:exaKey,modelBaseUrl,exaMcpUrl:exaUrl,auditRoot:root,timeoutMs:20000});
 assert.equal(result.status,'completed',result.error??'research did not complete');assert.deepEqual(result.exa_tools,['web_search_exa']);assert.equal(calls.length,1);assert.equal(rounds,2);
 const namespace=captured[0]?.tools?.find((tool:any)=>tool.type==='namespace'&&tool.name==='mcp__exa');assert.deepEqual(namespace?.tools.map((tool:any)=>tool.name).sort(),[...EXA_READ_TOOLS].sort());
 const audit=await readFile(join(result.run_directory,'result.json'),'utf8');assert.ok(!audit.includes(exaKey)&&!audit.includes('fixture-openai-secret'));
});
