import {z} from 'zod';
import {prescriptionInput} from './prescription-contract.js';

export const prescriptionOpenApi = {
  openapi: '3.1.0', info: {title: 'HouseMeds Prescription API', version: '1.2.0', description: 'Any frontend origin may call this API with a bearer token. Send a persistent random X-Housemed-Household-Key (64 lowercase hex characters) for state reads and writes. Household identity is derived on the server; AWS credentials never enter the browser.'},
  servers: [{url: '/'}], security: [{bearerAuth: []}],
  components: {securitySchemes: {bearerAuth: {type: 'http', scheme: 'bearer'}}, schemas: {PrescriptionRequest: z.toJSONSchema(prescriptionInput)}},
  paths: {
    '/healthz': {get: {summary: 'API health', security: [], responses: {'200': {description: 'API is running; does not test AWS availability'}}}},
    '/v1/prescription-chat/state': {get: {summary: 'Read household members and saved prescriptions through AgentCore and MCP', responses: {'200': {description: 'Members, prescriptions, provider, AWS request ID and MCP trace'}, '401': {description: 'Invalid bearer token'}, '502': {description: 'AWS runtime unavailable'}}}},
    '/v1/prescription-chat': {post: {summary: 'Add a household member, extract a photo, select a member, prepare manual fields, or save one/all medicines',
      parameters: [{in: 'header', name: 'X-Housemed-Household-Key', required: true, schema: {type: 'string', pattern: '^[a-f0-9]{64}$'}}, {in: 'header', name: 'X-Housemed-Session-Id', required: false, schema: {type: 'string', format: 'uuid'}}],
      requestBody: {required: true, content: {'application/json': {schema: {$ref: '#/components/schemas/PrescriptionRequest'}}}},
      responses: {'200': {description: 'Action result: member_created, needs_member, needs_review, needs_details, saved, or saved_all. Retain draft.id for subsequent turns.'}, '400': {description: 'Invalid request'}, '401': {description: 'Invalid bearer token'}, '413': {description: 'Image/request too large'}, '502': {description: 'AWS runtime unavailable; retry with the same request_id'}}}},
  },
};
