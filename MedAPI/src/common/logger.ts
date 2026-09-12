import { Logger } from '@aws-lambda-powertools/logger';

// Never log a raw Household/Member/Medicine field — HIPAA-adjacent data.
export const logger = new Logger({
  serviceName: 'medhouse-api',
  logLevel: (process.env.LOG_LEVEL as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR') ?? 'INFO',
});
