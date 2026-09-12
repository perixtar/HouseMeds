import {sharedApiUrl} from './shared-api.js';

const apiUrl = import.meta.env.VITE_API_BASE_URL || sharedApiUrl || 'http://127.0.0.1:63815';
const accessToken = import.meta.env.VITE_API_TOKEN || '';
const sessionId = sessionStorage.getItem('housemed_api_session') || crypto.randomUUID();
sessionStorage.setItem('housemed_api_session', sessionId);
// Remove credentials retained by older versions of the connection settings UI.
sessionStorage.removeItem('housemed_api_url');
sessionStorage.removeItem('housemed_api_token');

// Framework-independent HTTP client: no AWS SDK, Supabase credentials, cookies or UI-page bootstrap.
export async function callPrescriptionApi(body) {
  if (!accessToken) throw Error('HouseMeds is not configured. Ask your teammate to check the frontend environment.');
  const response = await fetch(apiUrl.replace(/\/$/, '') + '/v1/prescription-chat' + (body ? '' : '/state'), {
    method: body ? 'POST' : 'GET', credentials: 'omit',
    headers: {Authorization: `Bearer ${accessToken}`, 'X-Housemed-Session-Id': sessionId, ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(150_000),
  });
  const result = await response.json();
  if (!response.ok || result.status === 'error') throw Error(result.message || 'The prescription API could not respond.');
  return result;
}
