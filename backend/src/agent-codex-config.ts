import {isAbsolute,normalize} from 'node:path';

export const AGENT_CODEX_VERSION='0.153.4';
export const AGENT_MODEL='gpt-5.4-mini-2026-03-17';
export const HOUSEMED_READ_TOOLS=['search_catalog','get_listing_prices','get_medication_offers','get_source_status'] as const;
export const EXA_READ_TOOLS=['web_search_exa','web_fetch_exa'] as const;
export const EXA_MCP_URL='https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa';
export interface AgentCodexConfigOptions {
 instructionsPath:string;modelCatalogPath:string;nodePath:string;tsxLoaderPath:string;
 mcpScriptPath:string;mcpCwd:string;mcpEnv:{HOUSEMED_MCP_CONFIG:string};mockBaseUrl?:string;
}
export interface ResearchAgentCodexConfigOptions {
 instructionsPath:string;modelCatalogPath:string;mockBaseUrl?:string;exaMcpUrl?:string;
}
function absolute(value:string):string{
 if(typeof value!=='string'||!isAbsolute(value)||/[\u0000-\u001f]/.test(value))throw Error('AGENT_CONFIG_REQUIRES_ABSOLUTE_PATH');
 return normalize(value);
}
// Pinned client capability metadata is required: feature flags alone do not
// remove every host tool. This does not change the API model.
function modelCatalog(displayName:string,description:string,baseInstructions:string):string{
 return JSON.stringify({models:[{
  slug:AGENT_MODEL,display_name:displayName,description,
  default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low',description:'Bounded pricing lookup'}],
  shell_type:'unified_exec',visibility:'hide',supported_in_api:true,priority:0,upgrade:null,
  model_messages:null,base_instructions:baseInstructions,
  include_skills_usage_instructions:false,include_plugin_usage_instructions:false,include_apps_usage_instructions:false,
  default_reasoning_summary:'none',support_verbosity:true,default_verbosity:'low',
  apply_patch_tool_type:null,web_search_tool_type:'text_and_image',supports_search_tool:false,
  truncation_policy:{mode:'tokens',limit:8000},supports_image_detail_original:false,
  context_window:400000,max_context_window:400000,effective_context_window_percent:95,
  experimental_supported_tools:[],input_modalities:['text'],node_repl_disabled:true
 }]},null,2);
}
export function buildAgentModelCatalog():string{
 return modelCatalog('HouseMed pricing agent','Read-only medication pricing assistant','Use the supplied HouseMed pricing instructions.');
}
export function buildResearchAgentModelCatalog():string{
 return modelCatalog('HouseMed research agent','Read-only medication source research','Use the supplied HouseMed medication research instructions.');
}
function buildBaseConfig(options:{instructionsPath:string;modelCatalogPath:string;mockBaseUrl?:string}):string{
 let baseUrl='https://api.openai.com/v1';
 if(options.mockBaseUrl!==undefined){
  const url=new URL(options.mockBaseUrl);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash)throw Error('AGENT_MOCK_PROVIDER_MUST_BE_LOOPBACK');
  baseUrl=url.href.replace(/\/$/,'');
 }
 const quote=JSON.stringify;
 const disabled=['shell_tool','unified_exec','shell_snapshot','apps','plugins','remote_plugin','browser_use','browser_use_external',
  'browser_use_full_cdp_access','computer_use','in_app_browser','in_app_chat','in_app_local_automation','image_generation',
  'multi_agent','multi_agent_v2','goals','sleep_tool','hooks','code_mode','code_mode_host','code_mode_only','workspace_dependencies',
  'view_image','skill_search','skill_mcp_dependency_install','tool_suggest','memories','enable_request_compression'];
 return `model = ${quote(AGENT_MODEL)}
model_provider = "housemed_openai"
model_reasoning_effort = "low"
model_catalog_json = ${quote(absolute(options.modelCatalogPath))}
model_instructions_file = ${quote(absolute(options.instructionsPath))}
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
project_doc_max_bytes = 0
cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"
[model_providers.housemed_openai]
name = "HouseMed OpenAI API"
base_url = ${quote(baseUrl)}
wire_api = "responses"
env_key = "OPENAI_API_KEY"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 1
stream_max_retries = 0
[features]
${disabled.map(name=>`${name} = false`).join('\n')}
skip_host_skill_discovery = true
[tools.experimental_request_user_input]
enabled = false
[tools.update_plan]
enabled = false
[skills]
include_instructions = false
[skills.bundled]
enabled = false
[apps._default]
enabled = false
[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false
`;
}
export function buildAgentCodexConfig(options:AgentCodexConfigOptions):string{
 if(Object.keys(options.mcpEnv).some(key=>key!=='HOUSEMED_MCP_CONFIG'))throw Error('AGENT_MCP_ENV_NOT_ALLOWED');
 const quote=JSON.stringify;
 return `${buildBaseConfig(options)}
[mcp_servers.housemed]
command = ${quote(absolute(options.nodePath))}
args = ${quote(['--import',absolute(options.tsxLoaderPath),absolute(options.mcpScriptPath)])}
cwd = ${quote(absolute(options.mcpCwd))}
required = true
enabled_tools = ${quote(HOUSEMED_READ_TOOLS)}
startup_timeout_sec = 10
tool_timeout_sec = 15
[mcp_servers.housemed.env]
HOUSEMED_MCP_CONFIG = ${quote(absolute(options.mcpEnv.HOUSEMED_MCP_CONFIG))}
[history]
persistence = "none"
[analytics]
enabled = false
`;
}

export function buildResearchAgentCodexConfig(options:ResearchAgentCodexConfigOptions):string{
 const quote=JSON.stringify;
 const exaMcpUrl=options.exaMcpUrl??EXA_MCP_URL,url=new URL(exaMcpUrl);
 const production=exaMcpUrl===EXA_MCP_URL;
 const loopback=options.mockBaseUrl!==undefined&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Boolean(url.port)&&url.pathname==='/mcp'&&!url.username&&!url.password&&!url.search&&!url.hash;
 if(!production&&!loopback)throw Error('AGENT_EXA_URL_NOT_ALLOWED');
 return `${buildBaseConfig(options)}
[mcp_servers.exa]
url = ${quote(exaMcpUrl)}
required = true
enabled_tools = ${quote(EXA_READ_TOOLS)}
startup_timeout_sec = 15
tool_timeout_sec = 45
default_tools_approval_mode = "approve"
[mcp_servers.exa.env_http_headers]
"x-api-key" = "EXA_API_KEY"
[mcp_servers.exa.tools.web_search_exa]
approval_mode = "approve"
output_token_limit = 12000
[mcp_servers.exa.tools.web_fetch_exa]
approval_mode = "approve"
output_token_limit = 16000
[history]
persistence = "none"
[analytics]
enabled = false
`;
}
