# Shared prescription API

Every frontend calls the same HTTPS API. It accepts every origin (`Access-Control-Allow-Origin: *`) and authenticates with a bearer access token. Frontends do not need AWS credentials, the AWS SDK, Supabase credentials, cookies, or a backend-hosted login page.

The live URL is checked into [`config/prescription-api.json`](config/prescription-api.json) and the sample frontend defaults to it via [`../frontend/shared-api.js`](../frontend/shared-api.js). Get the **API access token** privately from the project owner. It is intentionally not committed.

```text
Any frontend (React, Vue, mobile web, curl)
    │ HTTPS JSON + Authorization: Bearer <API_TOKEN>
    ▼
HouseMeds API — AWS Lambda Function URL
    │ AWS SDK / scoped IAM role
    ▼
AWS AgentCore multimodal agent
    │ MCP / IAM-signed HTTPS
    ▼
HouseMeds MCP runtime
    │ Parameterized SQL / TLS
    ▼
Supabase Postgres
```

## Start the provided frontend

Use Node 24 or newer, pull this branch, then:

```sh
cd frontend
npm ci
npm run dev
```

Copy the owner's configured `frontend/.env` privately, or copy `frontend/.env.example` to `frontend/.env` and fill in `VITE_API_TOKEN` before starting. Open the printed frontend URL. The API settings load automatically and do not appear in the UI. This runs only the frontend on your computer; all prescription data comes from the deployed AWS backend.

Other frontends may use the same endpoints directly. There is no origin allowlist to update. Send `credentials: 'omit'`; this API does not use cross-site cookies.

```js
const API_URL = 'https://YOUR_SHARED_API.lambda-url.us-east-1.on.aws';
const API_TOKEN = 'YOUR_API_ACCESS_TOKEN';
const sessionId = crypto.randomUUID();
// Persist privately per browser profile; never use a shared key in frontend config.
let householdKey = localStorage.getItem('housemed_household_key');
if (!householdKey) {
  householdKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem('housemed_household_key', householdKey);
}

async function request(body) {
  const response = await fetch(`${API_URL}/v1/prescription-chat${body ? '' : '/state'}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'X-Housemed-Session-Id': sessionId,
      'X-Housemed-Household-Key': householdKey,
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const result = await response.json();
  if (!response.ok || result.status === 'error') throw new Error(result.message);
  return result;
}

const {members, prescriptions} = await request();
const extracted = await request({
  action: 'chat', request_id: crypto.randomUUID(), message: 'Add this prescription',
  image: {format: 'jpeg', data: IMAGE_BASE64_WITHOUT_DATA_URL_PREFIX},
});
// Populate your form from extracted.draft.fields; preserve extracted.draft.id.
// Use extracted.members for member choices and extracted.drafts for multi-medicine photos.

const selected = await request({
  action: 'chat', request_id: crypto.randomUUID(),
  draft_id: extracted.draft.id, message: 'Grandma',
});

const saved = await request({
  action: 'confirm', request_id: crypto.randomUUID(),
  draft_id: extracted.draft.id, member_id: selected.selected_member_id,
  fields: REVIEWED_FORM_FIELDS,
});
// Replace the displayed saved list with saved.prescriptions.
```

## Endpoints and contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Public API-process health; does not invoke AWS |
| GET | `/openapi.json` | Authenticated OpenAPI 3.1 specification |
| GET | `/v1/prescription-chat/state` | Read members and saved prescriptions through AgentCore → MCP → Supabase |
| POST | `/v1/prescription-chat` | Add a member, extract, select a member, prepare a manual draft, or save |
| OPTIONS | any API path | Unauthenticated browser CORS preflight |

Every state read and POST requires `X-Housemed-Household-Key`, a persistent 32-byte random capability encoded as 64 lowercase hex characters. The backend derives the household UUID using `HOUSEMED_HOUSEHOLD_SECRET`; the client cannot submit a household ID. Normal browser tabs share localStorage; Incognito has a separate key and empty household. Missing keys fail closed, without falling back to the previous shared household.

Every POST requires a UUID `request_id`. Reuse it when retrying the **same** upload or manual preparation; use a new ID for a new intake. `X-Housemed-Session-Id` is an optional UUID and is returned in the response headers. Drafts live in Supabase and remain usable with a new session after a reload/runtime restart. Keep `draft_id` in your application's state for review and confirmation.

Actions:

- `chat` with `message` and optional `image`: transcribe prescription details, normalize the first medicine, and save review drafts. Returns `needs_member` plus `members`, `draft`, and `drafts`.
- `chat` with `draft_id` and a member's exact nickname: select a database member for the review form. Returns `needs_review` and `selected_member_id`. A blank message restores the draft and its remaining batch.
- `create_member` with `nickname` (trimmed, 1–80 characters): persist a member through AgentCore and MCP. Returns `member_created`, the member, and refreshed members. Reuse `request_id` when retrying; a case-insensitive duplicate nickname reuses the member.
- `prepare` with `fields`: create a manual-entry draft without model extraction. Returns a draft; it is not a saved prescription yet.
- `confirm` with `draft_id`, `member_id`, and reviewed `fields`: persist once, then return `saved`, the saved `prescription`, and the refreshed `prescriptions` list. Changing an already-saved draft's member/fields is rejected.

`fields` contains string values for `medication`, `strength`, `form`, `directions`, `quantity`, `refills`, `prescriber`, and `pharmacy`, plus a `warnings` string array. Supply empty strings for missing values and `[]` for no warnings. `medication` is required. The backend rejects extra fields, including a caller-supplied `household_id`.

Photos: PNG, JPEG, or WebP, at most **3.75 MB decoded**, no data-URL prefix. The sample frontend accepts original files up to 10 MB, converts HEIC locally, and prepares dimensions/size before sending. Other frontends must prepare their images equivalently. Do not send image URLs; send the encoded bytes.

Successful responses include `provider: "aws-agentcore"`, an `aws_request_id`, and MCP `trace` entries. Photo extraction also includes `model_request_id`. `needs_details` means no usable prescription information was found. Unknown medication identities remain unverified, preserving the original text. A brand/strength with no form may resolve to an ingredient-strength concept without inventing a dosage form.

Errors: `400` invalid payload/session, `401` invalid/missing token, `413` oversized request, `502` runtime/tool failure. Browser-readable CORS headers are included on API errors. Do not claim a save succeeded until the API returns `status: "saved"`. Retry uncertain saves with the same draft; the database prevents duplicates.

## Run the API locally instead

The frontend does not need this, but backend developers can run the same API locally:

```sh
cd backend
npm ci
cp .env.prescriptions.example .env.prescriptions
# Set the runtime ARN, stable server-only HOUSEMED_HOUSEHOLD_SECRET, AWS region/profile, and API token.
npm run prescriptions:api
```

Default address: `http://127.0.0.1:63815`. The AWS identity needs only permission to invoke the existing AgentCore runtime and its DEFAULT endpoint. No Supabase login is required on the HTTP API server. Use the deployed ARN in `config/prescription-api.json`. Set `PRESCRIPTION_API_HOST=0.0.0.0` only when intentionally serving the API on your network. Any frontend origin remains allowed.

## Deploy or update the shared AWS API

This is an owner/backend operation, not a frontend setup step:

```sh
cd backend
npm ci
npm run prescriptions:bundle
cd ..
agentcore/.venv/bin/python agentcore/deploy_api.py --profile YOUR_AWS_PROFILE
```

The script uses the existing `.env.agentcore`/`.env.prescriptions`, reuses the access token, and provisions a Node 24 Lambda, a function URL, and a role scoped to the agent runtime. It updates the two nonsecret URL configuration files. The HTTP backend has no direct database access. The API timeout is 150 seconds; concurrency uses the AWS account’s existing Lambda quota. Its seven-day logs contain operational information; request bodies and tokens are not logged by the application.

The function URL uses AWS `NONE` URL authentication because the application validates its own bearer token. Public URL invocation permissions are restricted to the URL invocation path. CORS is set by Fastify, not duplicated by the optional Lambda CORS layer. The endpoint is publicly reachable, but prescription reads and writes require the token.

The API token authorizes this development API; a separate unguessable browser key scopes each household. `HOUSEMED_HOUSEHOLD_SECRET` stays on the server and must remain stable across deployments. The deploy script generates it once and retains it in the ignored backend environment. Browser keys must stay private: possession grants access to that household when combined with the API token. Clearing browser storage loses access to that anonymous household; existing data remains in Supabase. This is browser isolation, not per-user account authentication. Share it only with authorized teammates; do not embed it in a publicly distributed frontend. The sample frontend reads `VITE_API_TOKEN` from its ignored `.env` file. It does not display the token, but Vite includes it in browser builds and it is observable in requests. Use this configuration for trusted team development; a public multi-user frontend needs user authentication. AWS credentials and Supabase service credentials must never enter frontend config.

For runtime/MCP/database provisioning see [`../agentcore/README.md`](../agentcore/README.md). The legacy pricing API (`npm run api`) and pricing web server (`npm run web`) are separate services; the prescription API does not need either running.
