# Mock fixtures — `TARGET_SOURCE=mock`

Used by `src/adapters/mock/*` when the Med service is wired up with
`TARGET_SOURCE=mock` (the default — see `src/composition.ts` and CLAUDE.md's
"Target source" section). No real Cognito or Supabase call happens in this mode
(`fetchPrice` is hardcoded in both modes — see CLAUDE.md).

**All mock data lives in one file, `mock-data.json`** — every mock adapter imports
this same file and reads its own slice out of it; nothing imports a separate
per-call fixture file anymore. Its shape has two top-level sections, matching the
two kinds of port this project has:

## 1. `calls` — stateless external calls

One entry per port method that proxies a single external call (Cognito,
`fetchPrice`), each with a `request` and a `response`:

```json
"calls": {
  "signUp": { "request": {...}, "response": {...} },
  "login": { "request": {...}, "response": {...} },
  "requestPasswordReset": { "request": {...}, "response": {...} },
  "confirmPasswordReset": { "request": {...}, "response": {...} },
  "fetchPrice": { "request": {...}, "response": {...} }
}
```

`request` documents the shape of a typical request (for reference — the mock
adapter doesn't require the real call to match it byte-for-byte). `response` is
what the mock adapter actually returns; `fetchPrice` uses a name-keyed lookup
table (`prices`) with a `default` fallback, quoted across each of `pharmacies`
at that pharmacy's `multiplier`, so it works for whatever medicine name a caller
sends, not just one hardcoded example.

| `calls` key | Port |
|---|---|
| `signUp` | `AuthProvider.signUp` |
| `login` | `AuthProvider.login` |
| `requestPasswordReset` | `AuthProvider.requestPasswordReset` |
| `confirmPasswordReset` | `AuthProvider.confirmPasswordReset` |
| `fetchPrice` | `FetchPriceClient.fetchPrice` |

## 2. `repositories` — stateful repositories

`HouseholdRepository` and `PrescriptionRepository` are CRUD stores, not one-shot
calls — a fixed request/response pair can't represent "list what's been created so
far." Their mock implementations are an in-memory store seeded once at startup
from `repositories.household` / `repositories.prescription` (empty arrays by
default; add rows here to start the mock service with pre-existing data):

```json
"repositories": {
  "household": [],
  "prescription": []
}
```

## Editing these fixtures

Adding a new medicine name to `calls.fetchPrice.response.prices` makes the mock
aware of it; anything else falls back to `default`. No code change needed for
that. Adding a genuinely new mocked call (a new port method) does need a new
adapter method — see the `new-adapter` skill — plus a new `calls.{name}` entry
here.
