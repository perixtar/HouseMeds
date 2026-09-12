import type { FastifyReply, FastifyRequest } from 'fastify';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { householdRepository } from '../composition';
import { UnauthorizedError } from '../errors/domain-errors';
import { isLocalDev } from '../config/env';

declare module 'fastify' {
  interface FastifyRequest {
    householdId: string;
  }
}

// API Gateway's JWT authorizer already verified the token; this only reads
// the claim it attached and resolves it to a Household id.
export async function requireHousehold(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const cognitoSub = extractCognitoSub(request);
  if (!cognitoSub) {
    throw new UnauthorizedError('Missing or invalid authentication');
  }

  const household = await householdRepository.findByCognitoSub(cognitoSub);
  if (!household) {
    throw new UnauthorizedError('No household found for this account');
  }

  request.householdId = household.id;
}

function extractCognitoSub(request: FastifyRequest): string | undefined {
  const event = (
    request as unknown as {
      awsLambda?: { event?: APIGatewayProxyEventV2WithJWTAuthorizer };
    }
  ).awsLambda?.event;

  const sub = event?.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub === 'string') return sub;

  // isLocalDev() only — not isMockTarget(). A deployed Lambda always has
  // `event` populated, so this unverified-decode fallback stays local-only.
  if (isLocalDev()) {
    return decodeUnverifiedSub(request.headers.authorization);
  }

  return undefined;
}

function decodeUnverifiedSub(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  try {
    const token = authHeader.slice('Bearer '.length);
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof decoded.sub === 'string' ? decoded.sub : undefined;
  } catch {
    return undefined;
  }
}
