import awsLambdaFastify from '@fastify/aws-lambda';
import { buildApp } from './app';

// API Gateway HTTP API entrypoint — one Lambda, all routes, proxy integration.
const app = buildApp();

export const handler = awsLambdaFastify(app, {
  decorateRequest: true,
  // The Postgres client stays warm across invocations, so the event loop never
  // idles on its own — return on promise settle, not on event-loop drain.
  callbackWaitsForEmptyEventLoop: false,
});
