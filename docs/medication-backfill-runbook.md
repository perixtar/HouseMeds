# Medication normalization backfill runbook

This runbook is for Milestone 2 of the [medication normalization plan](medication-normalization-plan.md). It is intentionally separate from deployment and normal crawling. Do not run `apply` against the shared database until a production-like rehearsal and the staged report have been reviewed.

## Safety contract

- Use a dedicated login that inherits only `housemed_backfill`; never use the crawler or read-API credential.
- Pause collection before taking the backup and keep it paused through apply. A changed snapshot causes approval or apply to fail closed.
- Stage only from a logical-backup report whose restore test passed.
- Review every `needs_review`, `unmatched`, and `collision_review` item. Approximate RxNorm candidates are never eligible for automatic apply.
- Keep the backup, stage report, confirmation token, and reconciliation result together as one audit package.
- Do not use the compensation command after a new listing has linked to a backfilled legacy survivor. The command verifies this and refuses to proceed.

## Rehearsal

From `backend/`, configure the isolated database in `.env.backfill` and the ordinary worker backup values in `.env.worker`.

```bash
npm run backup -- --restore-test
npm run backfill:medications -- dry-run --output data/reports/medication-backfill-dry-run.json
npm run e2e:backfill
```

The backup report must contain the archive SHA-256, the canonical database-state hash, and `restore_verified: true`. Staging recomputes the same database-state hash and refuses a backup from an older or different snapshot. The dry run does not write to PostgreSQL; it reports counts for `ready`, `collision_review`, `needs_review`, `unmatched`, and target listings.

## Stage and review

```bash
npm run backfill:medications -- stage \
  --backup-report data/backups/<timestamp>.json.gz.report.json \
  --actor reviewer@example.com

npm run backfill:medications -- status --run <run-id>
```

Staging writes only the backfill run, immutable item decisions, and an append-only event. It does not change medication, listing, component, offer, or history rows.

Approve ordinary ready items after reviewing the report:

```bash
npm run backfill:medications -- approve --run <run-id> --actor reviewer@example.com
```

If the run contains canonical collisions, the first command leaves them unapplied. After manually verifying that every row in each collision group represents the same ingredient, strength, form, route, release type, and brand requirement, repeat approval on a fresh staged run with the explicit acknowledgement:

```bash
npm run backfill:medications -- approve --run <run-id> \
  --actor reviewer@example.com --approve-collisions
```

Approval prints the exact apply confirmation. Do not reconstruct it manually.

## Apply and verify

```bash
npm run backfill:medications -- apply --run <run-id> \
  --actor reviewer@example.com --confirm '<printed-apply-confirmation>'
```

Apply takes a global advisory lock and rechecks the staged snapshot. Approved changes occur in one transaction. It keeps medication rows, offers, offer history, crawl pages, and evidence; duplicate legacy medication rows become redirects to the selected active survivor.

Verify the command reconciliation and the authenticated API:

```bash
curl -s "$HOUSEMED_API_URL/v1/normalization/backfill/status" \
  -H "Authorization: Bearer $HOUSEMED_API_TOKEN"
```

The reconciliation must show identical medication/listing/offer/history counts and identical hashes for immutable listing fields, crawl pages, offers, and offer history.

## Compensation

Apply prints a separate compensation confirmation. Compensation is appropriate only before new consumers or listings depend on the migrated survivors.

```bash
npm run backfill:medications -- compensate --run <run-id> \
  --actor reviewer@example.com --confirm '<printed-compensation-confirmation>'
```

The command restores original medication and listing mappings and removes only component rows created by that run. Append-only match decisions and backfill events remain as historical evidence. If the compensation guard refuses because state changed, stop and restore the verified backup in an isolated environment before planning a manual recovery.

## MedAPI records

Old household medicine lines often lack strength, form, physical quantity unit, or a canonical medication ID. Those fields cannot be reconstructed reliably from a name alone. MedAPI therefore returns those lines as `normalizationStatus: "needs_review"`, with structured identity fields null and pricing disabled. The user must select a verified catalog result. A line that already has a canonical ID can follow a backfill redirect and adopts the active ID during its next successful server-side price refresh.
