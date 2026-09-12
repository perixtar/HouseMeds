# MedHouse API

A serverless API that lets a household track its members (human or pet) and their
medications, automatically refreshes each medicine's price from an external pricing
system on every create/update, and asynchronously computes a cheaper-alternative
recommendation in the background. Auth is email/password per household, backed by
Amazon Cognito. This is **not** a clinical advice tool.

- **Runtime**: Node.js 20, TypeScript (strict mode)
- **API framework**: Fastify, running inside AWS Lambda behind API Gateway
- **Data store**: MongoDB Atlas
- **Architecture style**: hexagonal (ports & adapters) — business logic never
  imports an AWS SDK or a database driver directly

## Table of contents

- [High-level architecture](#high-level-architecture)
- [Tech stack](#tech-stack)
- [Getting started (local, no AWS account needed)](#getting-started-local-no-aws-account-needed)
- [Running locally: mock vs. real AWS](#running-locally-mock-vs-real-aws)
- [Configuring real AWS services](#configuring-real-aws-services)
- [Deploying](#deploying)
- [Commands reference](#commands-reference)
- [API documentation](#api-documentation)
- [Project status](#project-status)

## High-level architecture

```mermaid
flowchart LR
    Client(["Client / curl / Swagger UI"])

    subgraph AWS["AWS (per stage: dev / prod)"]
        APIGW["API Gateway — HTTP API<br/>+ Cognito JWT Authorizer"]
        APILambda["API Lambda<br/>(Fastify app)"]
        WorkerLambda["Worker Lambda<br/>(getPriceComparison)"]
        SQS[("SQS queue")]
        SSM[("SSM Parameter Store<br/>secrets")]
        DDB[("DynamoDB<br/>idempotency table")]
        Cognito[("Amazon Cognito<br/>User Pool")]
        NAT["NAT Gateway<br/>(fixed outbound IP)"]
    end

    Atlas[("MongoDB Atlas")]
    Pricing[("External pricing API")]
    Vendor[("Price-comparison vendor")]

    Client -->|HTTPS| APIGW
    APIGW --> APILambda
    APIGW -.verifies token.-> Cognito
    APILambda -->|SignUp / Login / Reset| Cognito
    APILambda -->|enqueue job| SQS
    APILambda -->|idempotency key| DDB
    APILambda --> NAT
    APILambda -->|refresh price| Pricing
    SQS --> WorkerLambda
    WorkerLambda --> NAT
    WorkerLambda -->|quote lookup| Vendor
    NAT -->|fixed IP, allowlisted| Atlas
    APILambda -.reads secrets.-> SSM
    WorkerLambda -.reads secrets.-> SSM
```

The API Lambda handles every HTTP route (a single "Lambda-lith" behind one API
Gateway HTTP API, not one function per route); the Worker Lambda only runs the
price-comparison calculation, triggered by an SQS message the API Lambda enqueues
after saving a prescription — that's the one deliberately-async, heavier-compute
path. Both Lambdas sit in a private VPC subnet, routed through a NAT Gateway, so
MongoDB Atlas always sees traffic from one fixed, allowlistable IP instead of
Lambda's normal dynamic egress IP.

Inside the API Lambda, requests flow **routes → use-cases → ports → adapters**:
routes only validate input (Zod) and call a use-case; use-cases contain business
rules and depend only on port *interfaces*; adapters are the only code that talks
to Cognito, MongoDB, the pricing API, or SQS. Swapping `TARGET_SOURCE` (see below)
swaps every adapter for an in-memory/mock one without touching a single use-case.

## Tech stack

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript (strict), Node.js 20 |
| API framework | Fastify + `@fastify/aws-lambda` |
| Validation | Zod (request bodies, query params, env vars) |
| API docs | `@fastify/swagger` + `@fastify/swagger-ui`, generated from the same Zod schemas — never hand-written |
| Database | MongoDB Atlas (official `mongodb` driver) |
| Auth | Amazon Cognito (User Pool + App Client, one pair per stage) |
| Queue | Amazon SQS (decouples price-comparison compute from the request cycle) |
| Secrets | AWS SSM Parameter Store (`SecureString`), via `@aws-lambda-powertools/parameters` |
| Idempotency | DynamoDB, via `@aws-lambda-powertools/idempotency` |
| Observability | `@aws-lambda-powertools/logger` (structured JSON) + `tracer` (X-Ray) |
| Infra as code | Serverless Framework — one config file per stage (`serverless-dev.yml` / `serverless-prod.yml`) |
| Testing | Vitest — unit tests (mocked ports, no I/O) + adapter integration tests against recorded fixtures |
| Compute | AWS Lambda (API Lambda + Worker Lambda), Amazon API Gateway (HTTP API) |
| Networking | VPC private subnet + NAT Gateway, for a fixed outbound IP MongoDB Atlas can allowlist |

## Getting started (local, no AWS account needed)

Prerequisites: Node.js 20+, npm.

```bash
git clone <this-repo>
cd MedAPI
npm install
cp .env.example .env   # defaults to TARGET_SOURCE=mock — nothing else to configure yet
npm run dev             # local Fastify server on http://localhost:3000
```

That's it — with `TARGET_SOURCE=mock` (the default), every outbound call (Cognito,
MongoDB, the pricing API, SQS) is answered by an in-memory mock adapter reading
fixed data from [`mock-json/mock-data.json`](./mock-json/README.md). No AWS
account, no Mongo cluster, no API key needed to get a fully working server.

## Running locally: mock vs. real AWS

Every external dependency (Cognito, MongoDB, the pricing API, SQS) has two
implementations, picked by the `TARGET_SOURCE` env var:

### `mock` (default)

```bash
npm run dev
```

A full round trip, start to finish:

```bash
curl -s -X POST localhost:3000/register -H 'Content-Type: application/json' \
  -d '{"email":"demo@yopmail.com","password":"correct-horse-battery-staple"}'

TOKEN=$(curl -s -X POST localhost:3000/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@yopmail.com","password":"correct-horse-battery-staple"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['idToken'])")

curl -s -X POST localhost:3000/prescriptions \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: demo-1" \
  -H 'Content-Type: application/json' \
  -d '{"members":[{"nickname":"Rex","medicines":[{"name":"Amoxicillin","genericName":"amoxicillin","quantity":2}]}]}'
```

Medicine names not listed in `mock-json/mock-data.json`'s
`calls.getLatestPrices.response.prices` still work — they fall back to that
fixture's `default` price. Add a name there (and to
`calls.getPriceComparisonQuotes.response.prices`) to give it its own mock price.

### `aws` — the real thing

```bash
TARGET_SOURCE=aws npm run dev
# or set TARGET_SOURCE=aws in .env to make it the default for your shell
```

Requires a real Cognito user pool/app client, a MongoDB Atlas cluster, a pricing
API key, and an SQS queue actually configured in `.env` — see
[Configuring real AWS services](#configuring-real-aws-services) below. Never point
this at a cluster holding real household data from a local machine.

## Configuring real AWS services

Skip this whole section if you only need `mock` mode. To run against real
infrastructure (locally with `TARGET_SOURCE=aws`, or deployed), you need four
things set up once per stage (`dev`/`prod` never share any of them): a Cognito
User Pool + App Client, an SQS queue, three SSM parameters, and a MongoDB Atlas
cluster. All identifiers/secrets are read from `.env` — see `.env.example` for
every variable and which of these steps populates it.

### 1. Amazon Cognito — User Pool + App Client

```bash
aws cognito-idp create-user-pool --pool-name medhouse-households-<stage> \
  --auto-verified-attributes email \
  --policies '{"PasswordPolicy":{"MinimumLength":10,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true}}'

aws cognito-idp create-user-pool-client --user-pool-id <pool-id> \
  --client-name medhouse-web-client \
  --no-generate-secret \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH
```

Put the resulting IDs in `.env` as `COGNITO_USER_POOL_ID_<STAGE>` /
`COGNITO_APP_CLIENT_ID_<STAGE>` (and the unsuffixed `COGNITO_USER_POOL_ID` /
`COGNITO_APP_CLIENT_ID` if you're running `TARGET_SOURCE=aws` locally against
`dev`).

### 2. Amazon SQS — one queue per stage

```bash
aws sqs create-queue --queue-name medhouse-price-comparison-jobs-<stage> \
  --attributes VisibilityTimeout=90,MessageRetentionPeriod=1209600
```

Put the queue URL in `.env` as `PRICE_COMPARISON_QUEUE_URL`.

### 3. MongoDB Atlas cluster

1. Create a free (M0) or dedicated cluster in [Atlas](https://cloud.mongodb.com).
2. **Network Access** → add an IP allowlist entry. Never `0.0.0.0/0`:
   - For a **deployed** Lambda: allowlist the NAT Gateway's Elastic IP (see step 5
     below) — every Lambda invocation reaches Atlas from that one fixed address.
   - For **local** `TARGET_SOURCE=aws` development: allowlist your own current
     public IP (it changes per developer/network — each teammate adds their own).
3. **Database Access** → create a database user scoped to `readWrite` on this
   project's own database only — never an admin role.
4. **Connect** → get the connection string. **Use the standard (non-SRV) format**,
   not `mongodb+srv://` — a Lambda inside a VPC/NAT setup can't reliably resolve
   the SRV/TXT DNS records that scheme depends on, and it'll hang until Lambda's
   own timeout kills the request with no clear error. Atlas's "Connect" dialog
   offers a standard-format string directly (older driver / self-hosted option),
   or derive it yourself:
   ```bash
   dig +short SRV _mongodb._tcp.<your-cluster-host>
   dig +short TXT <your-cluster-host>
   ```
   then build `mongodb://user:pass@host1:27017,host2:27017,host3:27017/?ssl=true&replicaSet=<name>&authSource=admin&retryWrites=true&w=majority`
   from the SRV record's three hosts and the TXT record's `replicaSet`/`authSource`.
5. Put the finished connection string in `.env` as `MONGODB_URI`.

### 4. Pricing API key

Put your vendor's API key and base URL in `.env` as `PRICING_API_KEY` /
`PRICING_API_BASE_URL`.

### 5. SSM Parameter Store — push the secrets from `.env`

Once `MONGODB_URI` / `PRICING_API_KEY` / `PRICING_API_BASE_URL` are real values in
`.env`, push them to SSM (deployed Lambdas read secrets from SSM, never from a
local `.env` file):

```bash
aws ssm put-parameter --name /medhouse/<stage>/mongodb-uri --type SecureString --overwrite \
  --value "<value from .env's MONGODB_URI>"
aws ssm put-parameter --name /medhouse/<stage>/pricing-api-key --type SecureString --overwrite \
  --value "<value from .env's PRICING_API_KEY>"
aws ssm put-parameter --name /medhouse/<stage>/pricing-api-base-url --type SecureString --overwrite \
  --value "<value from .env's PRICING_API_BASE_URL>"
```

### 6. VPC / NAT Gateway (deployed stage only, not needed for local `aws` mode)

Only relevant once you deploy — a deployed Lambda needs a fixed IP for Atlas to
allowlist, since AWS doesn't give Lambda a static one by default:

1. A VPC with one public subnet (routed to an Internet Gateway) and one private
   subnet.
2. A NAT Gateway in the public subnet, with a new Elastic IP — **this has an
   hourly + per-GB cost** while it exists.
3. The private subnet's route table: `0.0.0.0/0 → NAT Gateway`.
4. Put the private subnet ID and a security group ID (egress-only: TCP 27017,
   TCP 443, TCP+UDP 53) in `.env` as `LAMBDA_SUBNET_ID_<STAGE>` /
   `LAMBDA_SECURITY_GROUP_ID_<STAGE>` — `serverless-{stage}.yml` attaches both
   Lambdas to them.
5. Allowlist the NAT Gateway's Elastic IP in Atlas (step 3 above).

## Deploying

```bash
TARGET_SOURCE=mock npm run deploy:dev   # deploy dev, Lambdas run against mock adapters
TARGET_SOURCE=aws npm run deploy:dev    # deploy dev, Lambdas run against real AWS/Mongo
TARGET_SOURCE=aws npm run deploy:prod   # deploy prod (once prod's Cognito/SQS/SSM exist)
```

A stage's target stage (`dev`/`prod`) picks *which* infrastructure gets deployed;
its target source (`mock`/`aws`) picks *what the deployed Lambdas talk to* once
live — the two are independent, and either stage can be deployed with either
source. Deploying always redeploys the same physical stack in place (`dev` or
`prod`), overwriting whichever target source it was previously running.

## Commands reference

```bash
npm run dev                # local Fastify server (TARGET_SOURCE=mock by default)
TARGET_SOURCE=aws npm run dev   # ...or against real Cognito/Mongo/pricing/SQS

npm run typecheck           # tsc --noEmit
npm run lint                # eslint + prettier check
npm run lint:fix            # auto-fix lint/format issues

npm run test                # unit tests — domain/ + usecases/, mocked ports, no I/O
npm run test:watch          # same, watch mode
npm run test:integration    # adapter tests against recorded fixtures

npm run deploy:dev          # sls deploy --config serverless-dev.yml
npm run deploy:prod         # sls deploy --config serverless-prod.yml
```

## API documentation

Every route is documented live by `@fastify/swagger` + `@fastify/swagger-ui`,
generated straight from the same Zod schemas that validate each request — input
and output shapes, auth requirements, and error responses, always current with
the code, never a hand-maintained spec that can drift.

| Environment | Swagger UI | Raw OpenAPI spec |
|---|---|---|
| Local (`npm run dev`) | http://localhost:3000/docs | http://localhost:3000/docs/json |
| `dev` (deployed) | `${API_BASE_URL_DEV}/docs` — see `.env`'s `API_BASE_URL_DEV` | `${API_BASE_URL_DEV}/docs/json` |
| `prod` (deployed) | _not yet deployed_ | _same_ |

`/docs` and `/docs/{proxy+}` are the only routes never behind API Gateway's
Cognito JWT authorizer (alongside `/register`, `/login`, and
`/reset-password*`), so the docs page is reachable by anyone with the URL, no
token needed — `/prescriptions*` and everything else require a valid Cognito
access token. To call a protected route from the Swagger UI page itself: run
`POST /login`, copy the returned `accessToken`, click **Authorize**, paste the
token (no `Bearer ` prefix — Swagger adds that), then any "Try it out" call
sends it automatically.

## Project status

Implemented: all routes, use-cases, domain logic, and adapters (both `mock` and
`aws` target sources) for registration/login/password-reset, prescription
CRUD with soft-delete, server-side price recalculation, and the async
price-comparison worker. `dev` is deployed and live under both target sources.
Not yet done:

- Adapter integration tests against recorded fixtures (`test:integration` has no
  specs yet).
- `prod` — Cognito/SQS/SSM/Lambdas/API Gateway not yet provisioned.
- A `/confirm-signup` endpoint — Cognito is configured to confirm new accounts via
  an emailed link (handled entirely by Cognito's hosted UI), so no app-side route
  is needed for the current signup flow.
- The pricing API's real request/response contract is assumed pending the actual
  vendor's API docs — update `src/adapters/pricing/pricing-api.adapter.ts` once
  confirmed.
