# HouseMeds backend

For the shared AWS prescription backend used by any frontend, start with [PRESCRIPTION_API.md](PRESCRIPTION_API.md). `npm run prescriptions:api` runs that API locally; `npm run api` below is the separate pricing-read service.


Backend implementation is in progress. The MVP has not passed acceptance testing.

See the [root README](../README.md) for startup, CLI, configuration, and test commands.

[Open the authoritative HTML technical plan](../docs/housemed-technical-plan.html) for architecture, setup decisions, operating instructions, and acceptance criteria. Keep planning content in that HTML document. Run backend commands from this folder.

[HealthWarehouse research evidence](../docs/research/healthwarehouse-2026-09-05/README.md) remains a separate dated record of the original source inspection.

The HTML plan is standalone documentation. The Node.js backend has no frontend framework.

## Cloud Run deployment

The read API is deployed for the hackathon with these resources:

- Google Cloud project: `housemeds-hack-260910-60da`
- Cloud Run region: `us-west1`
- Cloud Run service: `housemeds-api`
- Service URL: `https://housemeds-api-jg3hpr52da-uw.a.run.app`
- Runtime identity: `housemeds-api@housemeds-hack-260910-60da.iam.gserviceaccount.com`
- Build identity: `housemeds-builder@housemeds-hack-260910-60da.iam.gserviceaccount.com`

The service scales to zero and is capped at two instances. Cloud Run accepts public network requests, but the Fastify application still requires the `HOUSEMED_API_TOKEN` bearer token on every route. `READ_DATABASE_URL` and `HOUSEMED_API_TOKEN` are mounted from Google Secret Manager; do not pass their values on a command line or commit them.

Redeploy from this `backend/` directory after running `npm run check` and `npm run build`:

```bash
gcloud run deploy housemeds-api \
  --source=. \
  --build-service-account=projects/housemeds-hack-260910-60da/serviceAccounts/housemeds-builder@housemeds-hack-260910-60da.iam.gserviceaccount.com \
  --project=housemeds-hack-260910-60da \
  --region=us-west1 \
  --service-account=housemeds-api@housemeds-hack-260910-60da.iam.gserviceaccount.com \
  --set-secrets=READ_DATABASE_URL=housemeds-read-database-url:latest,HOUSEMED_API_TOKEN=housemeds-api-token:latest \
  --set-env-vars=HOST=0.0.0.0,NODE_ENV=production \
  --cpu=1 --memory=512Mi --concurrency=20 --timeout=15s \
  --min=0 --max=2 --no-invoker-iam-check
```

The local `npm run ask` client is not part of this deployment. It currently permits only a loopback API endpoint and must be updated separately before it can use the hosted API.

See [Use the database-backed read API](../README.md#use-the-database-backed-read-api) for authenticated request examples, route documentation, quantity semantics, and response interpretation.
