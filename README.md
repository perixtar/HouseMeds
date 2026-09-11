# HouseMeds

Medication catalog and pricing backend with a read-only CLI assistant. Backend files live in [`backend/`](backend/); documentation lives in [`docs/`](docs/).

The [HTML technical plan](docs/housemed-technical-plan.html) is the source of truth for architecture, implementation status, and MVP acceptance criteria. This README covers running the backend.

## Quick start on this Mac

Open Terminal and enter the backend directory:

```bash
cd /Users/qklu/Documents/HouseMeds/backend
```

All commands below run from that directory. For a clone elsewhere, use that checkout's `backend/` directory.

Check the existing API service:

```bash
npm run services -- status api
```

If it reports `running`, ask a question:

```bash
npm run ask -- "What medications are in our catalog?"
```

More examples:

```bash
npm run ask -- "Which metformin listings are in our catalog?"

npm run ask -- "Compare 30 lisinopril 20 mg tablets across our sources. Include estimates with unconfirmed stock."

npm run ask -- "Show all observed quantity tiers and prices for HealthWarehouse Metformin 500mg Tablets."
```

Each command handles one question. Use a complete question for each invocation; there is no persistent chat session. For structured output:

```bash
npm run ask -- --json "Show collection coverage and the last successful collection run for each source."
```

The assistant reads stored price observations. Prices depend on quantity, and Cost Plus estimates require explicit opt-in, as shown above. Background crawling is currently paused and the recurring Codex automation has been deleted. Asking a question does not refresh pharmacy prices; observations can become unavailable when they age beyond the freshness window.

## Pricing questions the data can answer

HouseMeds stores each observed quantity and total price as a separate offer. It can compare exact quantity tiers across pharmacies when the source listings have been reviewed and linked to the same canonical medication, strength, form, route, and release type.

| Question | Support today |
| --- | --- |
| What does 30, 90, or 180 tablets cost? | Yes, if that exact quantity was collected for the listing. |
| What is the price per pill? | It can be calculated from the response, but is not a stored field or an explicit API field. |
| Which pharmacy is cheaper? | Yes, for listings verified as the same medication identity. |
| Can I submit one list for a whole family? | Not in one request. There is no patient, household, saved medication-list, or batch-quote API yet. Query each medication separately. |
| Can I read historical prices? | The database retains offer history, but the read API does not expose it yet. |

An offer has an `ordering_quantity`, a listing has a `content_quantity` and `content_unit`, and the API returns their product as `physical_quantity`:

```text
physical_quantity = ordering_quantity * content_quantity
price_per_unit_usd = price_cents / 100 / physical_quantity
```

For a loose tablet, `content_quantity` is normally `1`, so an offer with `ordering_quantity: "90"`, `physical_quantity: "90"`, and `price_cents: "1260"` costs $12.60 total or $0.14 per tablet. Use the returned `content_unit` in the label: a quote might be per tablet, capsule, milliliter, or gram, so “per pill” is not always correct.

HouseMeds does not scale a 30-count price to estimate an unobserved 90- or 180-count price. It returns only an exact collected quantity. By default, offers also must be active, in stock, unexpired, and observed within the last 24 hours. Cost Plus prices with unconfirmed stock are excluded unless the caller explicitly sets `include_estimates=true`; those results remain labeled as requiring purchase verification.

For the hackathon, a family medication list should be processed ephemerally by making one exact-quantity query per medication. Do not attach names or family relationships to the requests. Persisting patient or household information would require a deliberate privacy, consent, retention, and access-control design that is outside the current schema.

## Use the read API

The API is read-only. It is available locally at `http://127.0.0.1:63813` and is deployed at `https://housemeds-api-jg3hpr52da-uw.a.run.app`. Every route requires the bearer token configured as `HOUSEMED_API_TOKEN`. Obtain the token through the team's approved secret-sharing process and put it in your environment; never commit it or paste it into documentation.

The examples below assume these variables are already set:

```bash
export HOUSEMED_API_URL=https://housemeds-api-jg3hpr52da-uw.a.run.app
test -n "$HOUSEMED_API_TOKEN" || echo "Set HOUSEMED_API_TOKEN first"
```

### Available routes

| Route | Purpose |
| --- | --- |
| `GET /v1/sources/status` | Collection status, catalog counts, and fresh/stale offer counts by source. |
| `GET /v1/medications` | Search canonical medication identities by name. |
| `GET /v1/listings` | Search pharmacy-specific product listings. |
| `GET /v1/medications/:id/offers` | Compare eligible offers across verified listings for one medication. |
| `GET /v1/listings/:id/offers` | Read eligible quantity tiers for one pharmacy listing. |

All requests use the same authorization header:

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${HOUSEMED_API_TOKEN:?Set HOUSEMED_API_TOKEN}" \
  "$HOUSEMED_API_URL/v1/sources/status"
```

Search for the canonical medication first. Search by medication name, then select the ID whose strength and form match the request:

```bash
curl --fail-with-body --silent --show-error --get \
  --header "Authorization: Bearer ${HOUSEMED_API_TOKEN:?Set HOUSEMED_API_TOKEN}" \
  --data-urlencode "q=lisinopril" \
  "$HOUSEMED_API_URL/v1/medications"
```

Use that `id` to request an exact physical quantity. Omitting `source` compares every configured pharmacy with a verified match:

```bash
MEDICATION_ID=1

curl --fail-with-body --silent --show-error --get \
  --header "Authorization: Bearer ${HOUSEMED_API_TOKEN:?Set HOUSEMED_API_TOKEN}" \
  --data-urlencode "quantity=90" \
  --data-urlencode "unit=tablet" \
  --data-urlencode "include_estimates=true" \
  "$HOUSEMED_API_URL/v1/medications/$MEDICATION_ID/offers"
```

`quantity` and `unit` must be supplied together. Valid optional filters are `source` (`healthwarehouse` or `costplus`), `location`, `program`, and `include_estimates`. List routes also accept `limit` and `cursor`; pass a non-null `next_cursor` into the next request to continue pagination.

To see all currently eligible quantity tiers for one source listing, search the source catalog and then omit quantity from the listing-offers request:

```bash
curl --fail-with-body --silent --show-error --get \
  --header "Authorization: Bearer ${HOUSEMED_API_TOKEN:?Set HOUSEMED_API_TOKEN}" \
  --data-urlencode "q=lisinopril" \
  --data-urlencode "source=healthwarehouse" \
  "$HOUSEMED_API_URL/v1/listings"

LISTING_ID=1

curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${HOUSEMED_API_TOKEN:?Set HOUSEMED_API_TOKEN}" \
  "$HOUSEMED_API_URL/v1/listings/$LISTING_ID/offers"
```

The IDs above are examples; always use IDs returned by the search response. `price_cents` is the total price as an integer-cent string, not a per-unit price. `ordering_quantity` is the number of source products ordered, while `physical_quantity` is the number of tablets, capsules, milliliters, or other `content_unit` received.

Check `quote_status` before presenting a result. An empty `items` array is explained by `exclusions`, for example `unsupported_quantity`, `not_matched`, `out_of_stock`, or `stale_or_expired`. HTTP `400` means invalid parameters, `401` means missing or incorrect credentials, `404` means the requested ID does not exist, and `503` means the API or database is temporarily unavailable.

## Start or restart the API

On this Mac, if the API service is not loaded, install and start **only the API service**:

```bash
npm run services -- install api
```

To restart an already loaded API service:

```bash
npm run services -- restart api
```

For foreground development when the service is not already using the port:

```bash
npm run api
```

Keep that terminal open and run `npm run ask` in a second terminal, also from `backend/`. The default API address is `http://127.0.0.1:63813`. API routes require the bearer token configured in `.env.api`.

These API commands preserve the paused crawl schedulers.

## First-time setup

This Mac is already configured. A fresh checkout needs:

- **Node.js 24 or newer** and npm.
- **Codex CLI 0.153.1** for the assistant. The runner checks `HOUSEMED_CODEX_BIN`, then PATH, then standard macOS app locations. On this Mac it finds `/Applications/ChatGPT.app/Contents/Resources/codex` automatically. The version check is intentional.
- Access to the provisioned Supabase database and its reader credentials. Schema and provisioning details are in the [HTML plan](docs/housemed-technical-plan.html); migrations are in [`backend/supabase/migrations/`](backend/supabase/migrations/).
- A funded OpenAI API key with access to the configured model, `gpt-5.4-mini-2026-03-17`. CLI model calls use API billing.

Install the pinned dependencies from `backend/`:

```bash
npm ci
```

Use [`backend/.env.example`](backend/.env.example) as a reference to create the separate configuration files:

| File inside `backend/` | Required values | Used by |
| --- | --- | --- |
| `.env.api` | `READ_DATABASE_URL`, `HOUSEMED_API_TOKEN`; optional `HOST` and `PORT` | Read API and CLI connection |
| `.env.agent` | `OPENAI_API_KEY`, `HOUSEMED_AGENT_KEY_NAME`, `HOUSEMED_AGENT_MODEL` | CLI assistant |
| `.env.worker` | `DATABASE_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_SECRET_KEY`; optional `CRAWL_DELAY_MS` | Collection and private backups; unnecessary for read-only CLI use |

The API token must be at least 32 characters. Keep worker credentials in `.env.worker`. Protect the files you create:

```bash
chmod 600 .env.api .env.agent
```

Apply the same permissions to `.env.worker` if you create it.

Credentials, collected data, dependencies, and local caches are excluded from Git. A fresh checkout does not contain this Mac's private configuration or local evidence files.

## Checks and troubleshooting

```bash
npm run check
npm test
```

Database tests require **PostgreSQL 17**. The test setup uses an isolated cluster in `backend/.cache/pg-test`, a local Unix socket, and port `65431`. Its default binaries are under `/opt/homebrew/opt/postgresql@17/bin`; set `PG_BIN` if installed elsewhere. The regression suite uses fixtures and mock model responses.

Optional real-model checks consume API credits:

```bash
npm run e2e:agent        # 36 model runs using an isolated fixture database
npm run e2e:agent:live   # Four questions against the running read API
```

| Symptom | Action |
| --- | --- |
| npm cannot find `package.json` | Run the command from `backend/`. |
| Port `63813` is already in use | Check `npm run services -- status api`; use the running API instead of starting another copy. |
| Codex cannot be found | Check the installed app/CLI, or set `HOUSEMED_CODEX_BIN` to the executable path. |
| `CODEX_VERSION_NOT_VALIDATED` | Use the pinned CLI version; a different version requires revalidation of its tool restrictions. |
| Pricing service unavailable | Check the API service, `.env.api`, and database connectivity. |
| No current eligible quote | The quantity may be unsupported, the observation may be stale, or stock/estimate rules may exclude it. |

API service logs are in `backend/data/logs/api.log` and `api.error.log`. Each CLI invocation retains its tool records and result under `backend/data/audits/agent/`.
