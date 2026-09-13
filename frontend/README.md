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

1. Add a name or nickname on **Who’s in your house?**, then open **Add a prescription with AI**.
2. Attach a photo from `data/` and send **Add this prescription**.
3. Reply with a household member's nickname or tap their choice.
4. Open **Review prescription**; check the populated form against the photo.
5. Choose **Save all N medicines** to save the photo batch, or **Save this medicine only**. You can also type **save all medicine** in chat; if no member is selected, choose one when asked and the agent saves the list. The household list and counts refresh from the API response.
6. Reload and select the member: the saved record is read back from Supabase.
7. Tap **Get [member]’s deals** to see example offers only for that member’s saved medicines. A member with no medicines gets an empty state, even if other members have saved medicines. Use **See all household deals** from the household member picker for the combined view. Select a medicine, then **Select this deal** to open its Cost Plus Drugs product page in the same tab. For an unknown or ambiguous product, **Browse Cost Plus Drugs** opens the pharmacy catalog. Back navigation returns to the view you came from.

## Family demo

Open <http://127.0.0.1:5173/?demo=family> for the fast, prefilled demo: Grandma has 9 sample medicines, Grandpa 9, and Dad 6. These local fixtures are labeled as demo data and never written into the live household. Open Dad → **Get Dad’s deals** → **Metformin ER 500 mg** → **Select this deal**. Use **Open your household to upload prescriptions** for the real image upload and Save all flow described above; the prefilled demo does not test extraction or persistence.

Prices and the Cost Plus first-offer ranking are demo assumptions. Product links come from `costplus-products.json`, a snapshot of public catalog fields read from Supabase plus supplemental entries from Cost Plus's documented public API. The export never contains household data. Refresh from `backend/` with `npx tsx scripts/export-demo-product-links.ts`; remove `.cache/costplus-public-catalog.json` first if you need a fresh pharmacy catalog fetch. Matching preserves name, strength and ER release markers; it does not use Supabase's potentially unmatched medication joins to substitute another drug. No order is submitted by opening a product link.

PNG, JPEG, WebP, and HEIC are supported. HEIC conversion is bundled into the frontend and runs locally. For multi-medicine photographs, use Save all or save each medicine individually. Edits survive switching medicines. Remaining drafts, member selection, and a pending save-all request are restored for the current tab. Free-text follow-ups use the model with the active intake context; they no longer fall back to an exact-name-only response. Manual entry uses the same API and persistence without model extraction.

## Configuration and build

- `shared-api.js`: checked-in shared AWS URL; no credentials.
- `.env`: `VITE_API_BASE_URL` overrides the default URL; `VITE_API_TOKEN` supplies the shared access token. This file is ignored by Git. Restart Vite after changing it.

```sh
npm run build
npm run preview
```

Deploy `dist/` to your frontend host. Vite includes `VITE_` values in the build: the token is absent from the interface but can be inspected in browser assets and requests. Use this shared token for the trusted team development environment; public multi-user deployments need user authentication.

Each browser profile stores its own random household key in localStorage. Normal tabs on the same frontend origin share that household; Chrome Incognito starts with an empty household and keeps it only for that private browsing session. Reloads preserve members, while clearing site data loses the browser key. There is no account recovery or cross-device household sharing yet. The former shared development household remains in the database, but new browser households start empty. Add members by name; duplicates reuse the existing member. The main app uses the household prototype’s deals screens with saved AWS prescriptions. `deals.js` supplies clearly labeled example prices and an actual Cost Plus product/catalog link. The AWS chat, image review, and prescription persistence remain connected to the shared backend.

`api.js` also exports `callDealsApi()` for the new single `GET /v1/deals` endpoint. It returns saved-medicine fields, eligible database offers, and clearly labeled Exa research candidates from additional pharmacies. The existing screenshot prototype is not yet switched to this endpoint; its example prices remain visibly marked as mock until the AgentCore/API deployment and UI hookup are complete.

See [the API contract, examples, architecture, and deployment instructions](../backend/PRESCRIPTION_API.md).

## Mock household prototype

The separate prototype from PR #7 is preserved in `mock/`. To run it, start `npm run frontend:mock` from `backend/` and open <http://127.0.0.1:63815>. Its household members, prescriptions, deals, and assistant responses are mock data; the in-memory data resets on restart. It does not call the shared AWS prescription API.

The mock host serves `mock/index.html`, `mock/app.js`, and `mock/api.js` with the shared styles and back navigation. The Vite app above remains the live AWS frontend. If the local prescription API already uses port 63815, run the mock with `FRONTEND_PORT=63816 npm run frontend:mock` and open that port instead.

The mock HTTP contract is:

- `GET /v1/me/household`
- `POST /v1/houses/:houseId/members`
- `DELETE /v1/members/:memberId`
- `GET /v1/members/:memberId/prescriptions`
- `POST /v1/members/:memberId/prescriptions`
- `GET /v1/deals?house_id=:houseId`
