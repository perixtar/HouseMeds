# HouseMeds frontend

The mobile UI from [PR #4](https://github.com/perixtar/HouseMeds/pull/4) now calls an independent HTTPS API. It can run on a teammate's computer or any static frontend host while sharing the same AWS AgentCore → MCP → Supabase backend.

## Run

Use Node 24 or newer:

```sh
cp .env.example .env
# Fill .env with the shared API settings supplied privately by your teammate.
npm ci
npm run dev
```

Open the printed address. The app reads the API URL and access token from `.env`; no connection settings or token appear in the UI. You can also copy the owner's configured `frontend/.env` privately. No AWS or Supabase credentials are needed. You do not need to start `backend/` for this shared setup.

The frontend uses ordinary `fetch`, bearer authentication, and no cookies. All frontend origins are allowed by the API. `api.js` is the small client boundary; React, Vue, or another frontend can call the same endpoints.

## Verify the user flow

1. Open **Add a prescription with AI**.
2. Attach a photo from `data/` and send **Add this prescription**.
3. Reply with a household member's nickname or tap their choice.
4. Open **Review prescription**; check the populated form against the photo.
5. **Save prescription**. The household list and counts refresh from the API response.
6. Reload and select the member: the saved record is read back from Supabase.

PNG, JPEG, WebP, and HEIC are supported. HEIC conversion is bundled into the frontend and runs locally. For multi-medicine photographs, review and save each medicine individually. Remaining drafts are restored for the current tab. Manual entry uses the same API and persistence without model extraction.

## Configuration and build

- `shared-api.js`: checked-in shared AWS URL; no credentials.
- `.env`: `VITE_API_BASE_URL` overrides the default URL; `VITE_API_TOKEN` supplies the shared access token. This file is ignored by Git. Restart Vite after changing it.

```sh
npm run build
npm run preview
```

Deploy `dist/` to your frontend host. Vite includes `VITE_` values in the build: the token is absent from the interface but can be inspected in browser assets and requests. Use this shared token for the trusted team development environment; public multi-user deployments need user authentication.

The supplied API token currently authorizes one shared development household. Members are read from the database; member administration is outside this prescription-intake flow. The separate pricing prototype is not part of prescription persistence.

See [the API contract, examples, architecture, and deployment instructions](../backend/PRESCRIPTION_API.md).
