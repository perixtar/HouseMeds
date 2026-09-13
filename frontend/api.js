import {sharedApiUrl} from './shared-api.js';
import {storageKey} from './demo.js';

const apiUrl = import.meta.env.VITE_API_BASE_URL || sharedApiUrl || 'http://127.0.0.1:63815';
const accessToken = import.meta.env.VITE_API_TOKEN || '';
const householdStorageKey = storageKey('housemed_household_key');
let householdKey = localStorage.getItem(householdStorageKey);
if (!householdKey) {
  householdKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,'0')).join('');
  localStorage.setItem(householdStorageKey, householdKey);
  // A draft from the previous shared development household is not in this browser's household.
  sessionStorage.removeItem(storageKey('housemed_mobile_draft_id'));
}
// AgentCore keeps existing sessions on their original code version. Start a new
// session for the batch-save conversation protocol, retaining drafts in the database.
const sessionStorageKey = storageKey('housemed_api_session_v4');
const sessionId = sessionStorage.getItem(sessionStorageKey) || crypto.randomUUID();
sessionStorage.setItem(sessionStorageKey, sessionId);
sessionStorage.removeItem('housemed_api_session');
sessionStorage.removeItem('housemed_api_session_v2');
sessionStorage.removeItem('housemed_api_session_v3');
// Remove credentials retained by older versions of the connection settings UI.
sessionStorage.removeItem('housemed_api_url');
sessionStorage.removeItem('housemed_api_token');

// Framework-independent HTTP client: no AWS SDK, Supabase credentials, cookies or UI-page bootstrap.
export async function callPrescriptionApi(body) {
  if (!accessToken) throw Error('HouseMeds is not configured. Ask your teammate to check the frontend environment.');
  const response = await fetch(apiUrl.replace(/\/$/, '') + '/v1/prescription-chat' + (body ? '' : '/state'), {
    method: body ? 'POST' : 'GET', credentials: 'omit',
    headers: {Authorization: `Bearer ${accessToken}`, 'X-Housemed-Session-Id': sessionId, 'X-Housemed-Household-Key': householdKey, ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(150_000),
  });
  const result = await response.json();
  if (!response.ok || result.status === 'error') throw Error(result.message || 'The prescription API could not respond.');
  return result;
}

// One client-facing read for the deals screens. Pharmacy research remains
// server-side in AgentCore; never send Exa credentials from the browser.
export async function callDealsApi() {
  if (!accessToken) throw Error('HouseMeds is not configured. Ask your teammate to check the frontend environment.');
  const response = await fetch(apiUrl.replace(/\/$/, '') + '/v1/deals', {
    method: 'GET', credentials: 'omit',
    headers: {Authorization: `Bearer ${accessToken}`, 'X-Housemed-Session-Id': sessionId, 'X-Housemed-Household-Key': householdKey},
    signal: AbortSignal.timeout(150_000),
  });
  const result = await response.json();
  if (!response.ok || result.status === 'error') throw Error(result.message || 'The deals API could not respond.');
  return result;
}
