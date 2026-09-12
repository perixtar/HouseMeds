import test from 'node:test';
import assert from 'node:assert/strict';
import {handler} from '../src/prescription-lambda.js';

test('Lambda Function URL transport preserves preflight, auth errors, and base64 JSON requests', async () => {
  process.env.HOUSEMED_PRESCRIPTION_API_TOKEN = 'lambda-test-token-with-at-least-32-characters';
  process.env.HOUSEMED_HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
  process.env.HOUSEMED_AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test';
  process.env.AWS_REGION = 'us-east-1';
  const preflight = await handler({rawPath: '/v1/prescription-chat', headers: {origin: 'https://frontend.example'}, requestContext: {http: {method: 'OPTIONS'}}});
  assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], '*');
  const denied = await handler({rawPath: '/v1/prescription-chat/state', requestContext: {http: {method: 'GET'}}});
  assert.equal(denied.statusCode, 401);
  const invalid = await handler({rawPath: '/v1/prescription-chat', requestContext: {http: {method: 'POST'}},
    headers: {authorization: 'Bearer '+process.env.HOUSEMED_PRESCRIPTION_API_TOKEN, 'content-type': 'application/json'},
    isBase64Encoded: true, body: Buffer.from(JSON.stringify({action: 'chat', request_id: 'invalid'})).toString('base64')});
  assert.equal(invalid.statusCode, 400); assert.equal(JSON.parse(invalid.body).error, 'invalid_request');
  assert.equal(invalid.headers['access-control-allow-origin'], '*');
});
