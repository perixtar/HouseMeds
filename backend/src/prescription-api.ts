import Fastify from 'fastify';
import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {agentCoreInvoker, type AgentInvoker} from './agentcore-client.js';
import {prescriptionInput} from './prescription-contract.js';
import {prescriptionOpenApi} from './prescription-openapi.js';

export interface PrescriptionApiConfig {
  apiToken: string;
  householdSecret: string;
  householdName?: string;
  invoke: AgentInvoker;
}

export function prescriptionApiConfig(env: NodeJS.ProcessEnv = process.env): PrescriptionApiConfig {
  const values = z.object({
    HOUSEMED_PRESCRIPTION_API_TOKEN: z.string().min(32),
    HOUSEMED_HOUSEHOLD_SECRET: z.string().min(32),
    HOUSEMED_AGENT_RUNTIME_ARN: z.string().startsWith('arn:aws:bedrock-agentcore:'),
    AWS_REGION: z.string().min(1),
  }).safeParse(env);
  if (!values.success) throw Error('Configure HOUSEMED_PRESCRIPTION_API_TOKEN, HOUSEMED_HOUSEHOLD_SECRET (32+ characters each), HOUSEMED_AGENT_RUNTIME_ARN, and AWS_REGION on the backend.');
  const v = values.data;
  return {apiToken: v.HOUSEMED_PRESCRIPTION_API_TOKEN, householdSecret: v.HOUSEMED_HOUSEHOLD_SECRET,
    householdName: 'My household',
    invoke: agentCoreInvoker(v.HOUSEMED_AGENT_RUNTIME_ARN, v.AWS_REGION, env.AWS_PROFILE)};
}

export function buildPrescriptionApi(config: PrescriptionApiConfig) {
  if (config.apiToken.length < 32 || config.householdSecret.length < 32) throw Error('Invalid prescription API configuration');
  const app = Fastify({logger: false, bodyLimit: 5_200_000, requestTimeout: 180_000});
  const tokenHash = createHash('sha256').update(config.apiToken).digest();
  app.addHook('onRequest', async (req, reply) => {
    // Any frontend origin can call this API. Authorization is independent of CORS.
    reply.header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Housemed-Session-Id, X-Housemed-Household-Key')
      .header('Access-Control-Expose-Headers', 'X-Housemed-Session-Id')
      .header('Access-Control-Max-Age', '3600').header('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return reply.code(204).send();
    if (req.method === 'GET' && req.url.split('?')[0] === '/healthz') return;
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!match || !timingSafeEqual(tokenHash, createHash('sha256').update(match[1]).digest()))
      return reply.header('WWW-Authenticate', 'Bearer').code(401).send({error: 'unauthorized', message: 'Supply a valid HouseMeds API access token.'});
  });
  app.setErrorHandler((error, _req, reply) => {
    const status = (error as {statusCode?: number}).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? status : 500).send({
      error: status === 413 ? 'image_too_large' : 'invalid_request',
      message: status === 413 ? 'Prepare the image to at most 3.75 MB before sending it.' : 'The request could not be processed.'});
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());
  app.get('/healthz', async () => ({status: 'ok', service: 'housemed-prescription-api', provider: 'aws-agentcore'}));
  app.get('/openapi.json', async () => prescriptionOpenApi);
  async function invoke(payload: Record<string, unknown>, sessionHeader: unknown, householdKey: string) {
    const session = sessionHeader === undefined ? randomUUID() : z.string().uuid().parse(sessionHeader);
    // Browser key is an unguessable capability, never a caller-selected household UUID.
    // The server-only secret makes household identities stable across API deployments.
    const bytes = createHmac('sha256', config.householdSecret).update(householdKey).digest().subarray(0,16);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex=bytes.toString('hex'); const householdId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    try {
      const result = await config.invoke({...payload, household_id: householdId}, session);
      return {session, result: {...result, household_name: config.householdName ?? 'Your household'}};
    } catch {
      return {session, result: {status: 'error', error: 'agent_unavailable', message: 'The prescription service could not respond. Retry with the same request_id; each draft can only be saved once.'}};
    }
  }
  const sessionSchema = z.string().uuid().optional();
  app.addHook('preValidation', async (req, reply) => {
    if (!sessionSchema.safeParse(req.headers['x-housemed-session-id']).success)
      return reply.code(400).send({error: 'invalid_session', message: 'X-Housemed-Session-Id must be a UUID.'});
    if ((req.url.split('?')[0].startsWith('/v1/prescription-chat') || req.url.split('?')[0] === '/v1/deals') &&
      !z.string().regex(/^[a-f0-9]{64}$/).safeParse(req.headers['x-housemed-household-key']).success)
      return reply.code(400).send({error: 'invalid_household_key', message: 'Supply a persistent 32-byte random X-Housemed-Household-Key as 64 lowercase hexadecimal characters.'});
  });
  app.get('/v1/prescription-chat/state', async (req, reply) => {
    const {result, session} = await invoke({action: 'state', request_id: randomUUID()}, req.headers['x-housemed-session-id'], req.headers['x-housemed-household-key'] as string);
    return reply.header('X-Housemed-Session-Id', session).code(result.status === 'error' ? 502 : 200).send(result);
  });
  app.get('/v1/deals', async (req, reply) => {
    const {result, session} = await invoke({action: 'deals', request_id: randomUUID()}, req.headers['x-housemed-session-id'], req.headers['x-housemed-household-key'] as string);
    return reply.header('X-Housemed-Session-Id', session).code(result.status === 'error' ? 502 : 200).send(result);
  });
  app.post('/v1/prescription-chat', async (req, reply) => {
    const parsed = prescriptionInput.safeParse(req.body);
    if (!parsed.success || (parsed.data.action === 'prepare' && !parsed.data.fields))
      return reply.code(400).send({error: 'invalid_request', message: 'Check the action, request_id, prescription fields, and image. Images must be JPEG, PNG or WebP under 3.75 MB.'});
    const {result, session} = await invoke(parsed.data, req.headers['x-housemed-session-id'], req.headers['x-housemed-household-key'] as string);
    return reply.header('X-Housemed-Session-Id', session).code(result.status === 'error' ? 502 : 200).send(result);
  });
  return app;
}
