import { z } from 'zod';
import { getParameter } from '@aws-lambda-powertools/parameters/ssm';
import { logger } from '../common/logger';

// getParameter has no default timeout — guard against a silent hang.
async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms: number,
): Promise<T> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    logger.info(`${label} succeeded`, { durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    logger.error(`${label} failed`, {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearTimeout(timer!);
  }
}

// Non-secret config, validated once at module load. AWS-only identifiers
// are optional here, required at point of use by real adapters (requireEnv).
const nonSecretEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TARGET_SOURCE: z.enum(['mock', 'aws']).default('mock'),
  AWS_REGION: z.string().min(1).default('us-west-1'),
  COGNITO_USER_POOL_ID: z.string().min(1).optional(),
  COGNITO_APP_CLIENT_ID: z.string().min(1).optional(),
  PRICE_COMPARISON_QUEUE_URL: z.string().url().optional(),
  IDEMPOTENCY_TABLE_NAME: z.string().min(1).optional(),
  // This stage's API Gateway endpoint, for the Swagger UI "servers" entry.
  API_BASE_URL: z.string().url().optional(),
  // Local-dev fallbacks for secrets normally read from SSM.
  MONGODB_URI: z.string().optional(),
  PRICING_API_KEY: z.string().optional(),
  PRICING_API_BASE_URL: z.string().url().optional(),
  MONGODB_URI_SSM_PARAM: z.string().default('/medhouse/mongodb-uri'),
  PRICING_API_KEY_SSM_PARAM: z.string().default('/medhouse/pricing-api-key'),
});

export type NonSecretEnv = z.infer<typeof nonSecretEnvSchema>;

let cachedEnv: NonSecretEnv | undefined;

export function getEnv(): NonSecretEnv {
  if (!cachedEnv) {
    cachedEnv = nonSecretEnvSchema.parse(process.env);
  }
  return cachedEnv;
}

export function isLocalDev(): boolean {
  return getEnv().NODE_ENV !== 'production';
}

/** `true` unless `TARGET_SOURCE=aws` is set. */
export function isMockTarget(): boolean {
  return getEnv().TARGET_SOURCE !== 'aws';
}

/** Used only by real (non-mock) adapters to fail fast with a clear message
 * instead of letting `undefined` reach an AWS SDK call. */
export function requireEnv<K extends keyof NonSecretEnv>(
  key: K,
): NonNullable<NonSecretEnv[K]> {
  const value = getEnv()[key];
  if (value === undefined || value === '') {
    throw new Error(
      `${key} is required when TARGET_SOURCE=aws but is not set — check .env / SSM`,
    );
  }
  return value as NonNullable<NonSecretEnv[K]>;
}

// Fetched once per container lifetime, never per request.
let cachedMongoUri: string | undefined;
let cachedPricingApiKey: string | undefined;

export async function getMongoUri(): Promise<string> {
  if (cachedMongoUri) return cachedMongoUri;

  const env = getEnv();
  if (isLocalDev() && env.MONGODB_URI) {
    cachedMongoUri = env.MONGODB_URI;
    return cachedMongoUri;
  }

  const value = await withTimeout(
    getParameter(env.MONGODB_URI_SSM_PARAM, { decrypt: true }),
    'ssm.getParameter(mongodb-uri)',
    5000,
  );
  if (!value) {
    throw new Error(`SSM parameter ${env.MONGODB_URI_SSM_PARAM} returned no value`);
  }
  cachedMongoUri = value;
  return cachedMongoUri;
}

export async function getPricingApiKey(): Promise<string> {
  if (cachedPricingApiKey) return cachedPricingApiKey;

  const env = getEnv();
  if (isLocalDev() && env.PRICING_API_KEY) {
    cachedPricingApiKey = env.PRICING_API_KEY;
    return cachedPricingApiKey;
  }

  const value = await withTimeout(
    getParameter(env.PRICING_API_KEY_SSM_PARAM, { decrypt: true }),
    'ssm.getParameter(pricing-api-key)',
    5000,
  );
  if (!value) {
    throw new Error(`SSM parameter ${env.PRICING_API_KEY_SSM_PARAM} returned no value`);
  }
  cachedPricingApiKey = value;
  return cachedPricingApiKey;
}

export function getPricingApiBaseUrl(): string {
  const env = getEnv();
  if (!env.PRICING_API_BASE_URL) {
    throw new Error('PRICING_API_BASE_URL is not configured');
  }
  return env.PRICING_API_BASE_URL;
}
