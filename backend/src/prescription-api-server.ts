import {existsSync} from 'node:fs';
import {buildPrescriptionApi, prescriptionApiConfig} from './prescription-api.js';

if (existsSync('.env.prescriptions')) process.loadEnvFile('.env.prescriptions');
const app = buildPrescriptionApi(prescriptionApiConfig());
const host = process.env.PRESCRIPTION_API_HOST ?? '127.0.0.1';
const port = Number(process.env.PRESCRIPTION_API_PORT ?? 63815);
process.once('SIGTERM', () => app.close()); process.once('SIGINT', () => app.close());
await app.listen({host, port});
console.log(`HouseMeds prescription API: http://${host}:${port} (all frontend origins allowed; bearer token required)`);
