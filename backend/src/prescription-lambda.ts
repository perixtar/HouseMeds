import {buildPrescriptionApi, prescriptionApiConfig} from './prescription-api.js';
import type {InjectOptions} from 'fastify';

let app: ReturnType<typeof buildPrescriptionApi> | undefined;
interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  requestContext: {http: {method: string}};
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export async function handler(event: FunctionUrlEvent) {
  app ??= buildPrescriptionApi(prescriptionApiConfig());
  const result = await app.inject({
    method: event.requestContext.http.method as InjectOptions['method'],
    url: event.rawPath + (event.rawQueryString ? '?' + event.rawQueryString : ''),
    headers: event.headers ?? {},
    ...(event.body ? {payload: Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')} : {}),
  });
  return {statusCode: result.statusCode,
    headers: Object.fromEntries(Object.entries(result.headers).filter(([key]) => !['content-length', 'transfer-encoding', 'connection'].includes(key)).map(([key, value]) => [key, String(value)])),
    body: result.body, isBase64Encoded: false};
}
