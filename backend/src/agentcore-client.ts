import {BedrockAgentCoreClient, InvokeAgentRuntimeCommand} from '@aws-sdk/client-bedrock-agentcore';
import {fromIni} from '@aws-sdk/credential-providers';
export type AgentInvoker=(payload:Record<string,unknown>,sessionId:string)=>Promise<Record<string,any>>;
export function agentCoreInvoker(arn:string,region:string,profile?:string):AgentInvoker{
 const client=new BedrockAgentCoreClient({region,...(profile?{credentials:fromIni({profile})}:{})});
 return async(payload,sessionId)=>{
  const response=await client.send(new InvokeAgentRuntimeCommand({agentRuntimeArn:arn,qualifier:'DEFAULT',runtimeSessionId:sessionId,contentType:'application/json',accept:'application/json',payload:Buffer.from(JSON.stringify(payload))}),{abortSignal:AbortSignal.timeout(120_000)});
  if(!response.response)throw Error('empty_agent_response');
  const result=JSON.parse(await response.response.transformToString());
  return {...result,aws_request_id:response.$metadata.requestId};
 };
}
