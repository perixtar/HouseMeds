# HouseMeds

Medication catalog and pricing backend with a read-only CLI assistant. Backend files live in [`backend/`](backend/); documentation lives in [`docs/`](docs/).

The [HTML technical plan](docs/housemed-technical-plan.html) is the source of truth for architecture, implementation status, and MVP acceptance criteria. This README covers running the backend.

## Quick start on this Mac

Open Terminal and enter the backend directory:

```bash
cd /Users/qklu/Documents/HouseMed/backend
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

## Price-comparison web UI

A browser page that takes a medication name and shows 30-, 90- and 365-day cash prices at Walmart,
Costco, Cost Plus Drugs and Amazon Pharmacy, with every price linking to that pharmacy's own page.

```bash
npm run web
```

Then open <http://127.0.0.1:63814/>. It needs no database and no token, so it runs on a fresh
checkout; the read API on port `63813` is unaffected.

### API

| Route | Purpose |
| --- | --- |
| `GET /v1/price-comparison?medication=<name>&strength=<strength>` | The four-supplier, three-tier comparison. `strength` is optional and defaults to the lowest catalogued strength. |
| `GET /v1/medications?q=<text>&limit=<n>` | Type-ahead suggestions with the strengths on file. |
| `GET /healthz` | Liveness, and which pricing source is in use. |

```bash
curl 'http://127.0.0.1:63814/v1/price-comparison?medication=Carvedilol&strength=12.5mg'
```

Each response carries `suppliers[]` (one entry per pharmacy, each with `quotes[]` for 30, 90 and 365
days, a `price_cents`, a `price_per_day_cents`, a `pricing_basis` and a `purchase_url`),
`best_by_days_supply` for the cheapest pharmacy in each tier, and `best_value` for the lowest cost
per day overall.

### Where the numbers come from

`data_source` is `mock` in every response. Prices are served by
[`backend/src/pricing-catalog.ts`](backend/src/pricing-catalog.ts) from the snapshot in
[`backend/mock/pricing-catalog.json`](backend/mock/pricing-catalog.json) — **they are not collected
observations, and the page says so.** Replace `lookupComparison` with repository queries to move the
page onto real data; the response shape is meant to survive that swap.

- **Cost Plus Drugs** rows — medication identity, NDC, per-unit price and product URL — are a
  snapshot of that pharmacy's public catalog API, so its prices and links are real.
- **Walmart, Costco and Amazon** figures are modelled from the Cost Plus acquisition price using the
  per-supplier markup, fee and quantity-discount model in `pricing-catalog.ts`. Walmart's $4/$10
  generic program is applied where the drug is on that list.

Link destinations were checked in a real Chrome session:

| Pharmacy | Link opens |
| --- | --- |
| Cost Plus Drugs | The product page for that exact strength, with its own price calculator. |
| Amazon Pharmacy | `pharmacy.amazon.com` search results for the drug, with live listings and prices. |
| Costco | The Member Prescription Program page named for the drug. Costco's `drug-directory-search-results` URL looks right but redirects to their home page once warehouse cookies are set, so it is deliberately not used. |
| Walmart | The $4/$10 program page that documents the quoted price, or the pharmacy page for drugs not on that list — Walmart publishes no public per-drug cash price page. |

The UI prints each link's destination on the supplier card, so a link never implies a product page it
does not open.

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
