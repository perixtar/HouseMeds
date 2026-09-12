# Medication identity and value normalization plan

Status: Milestone 1 implemented and E2E-verified locally; deployment/shadow observation pending. Milestone 2 is not implemented.
Last updated: 2026-09-12
Scope: PostgreSQL pricing service in `backend/`, household service in `MedAPI/`, and their API contract

This document is an implementation supplement to the authoritative [HouseMeds technical plan](housemed-technical-plan.html). It defines how HouseMeds will normalize medication names, strengths, forms, and purchasable quantity units without merging clinically different products.

## Decision

HouseMeds will retain its own stable `medication_id`, use RxNorm as the external semantic authority when a suitable active concept exists, and use deterministic text normalization only for parsing and candidate lookup.

An approximate name match is never sufficient to merge records. Every cross-pharmacy comparison must resolve to the same reviewed medication identity. Ambiguous, incomplete, conflicting, or unsupported input remains unmatched or moves to `needs_review`.

The normalized medication identity is separate from:

- A pharmacy listing and its SKU, NDC, URL, packaging, or price.
- A household prescription line and its patient-entered directions.
- A dosage regimen such as “take one tablet twice daily.”
- A purchasable quantity such as 30 tablets or two boxes.

## Current state and gap

The current production pricing schema identifies a medication by the exact text tuple `name + strength + form + route + release_type`. PostgreSQL uniqueness and the repository upsert use those raw values without canonical name or unit normalization. Differences such as `Lisinopril` versus `lisinopril`, `20mg` versus `20 mg`, or `tablet` versus `tablets` can therefore create distinct medication rows.

The current protections remain valuable:

- `listings(source_id, source_product_key)` prevents reinserting the same pharmacy product.
- A changed identity on an existing listing is quarantined as `needs_review`.
- Only verified listings participate in cross-source comparisons.

They do not deduplicate equivalent canonical medications across differently formatted source values.

`MedAPI` currently gives each household medicine line a local UUID and stores only `name`, `genericName`, and integer `quantity`. It sends that local UUID as `medicineId` to a planned batch pricing route. It does not yet carry the canonical pricing `medication_id`, strength, form, route, release type, or quantity unit. The implementation must separate a prescription-line ID from a canonical medication ID.

The prototype price-comparison web catalog has its own search normalization and `doses_per_day` field. Those mock values are not the production normalization contract and must not be used to backfill the pricing database.

## Target identity model

One HouseMeds medication represents one fully specified clinical-drug identity:

```text
ingredient component(s) + component strength(s) + dose form + route + release type
```

When available, the preferred external key is an active RxNorm Semantic Clinical Drug (`SCD`) RXCUI for a generic product or Semantic Branded Drug (`SBD`) RXCUI when brand identity is required. Ingredient RXCUIs are stored separately and do not replace the fully specified clinical-drug identity.

HouseMeds retains its internal `medication_id` even when an RXCUI is present. External terminology concepts can be updated, remapped, or retired; internal references must remain stable and auditable.

### Proposed canonical medication fields

| Field | Purpose |
| --- | --- |
| `id` | Stable HouseMeds medication ID. |
| `canonical_name` | Preferred display name, normally the RxNorm normalized name. |
| `rxnorm_rxcui` | Nullable external clinical-drug identifier. Unique for active canonical rows when present. |
| `rxnorm_term_type` | Expected to be `SCD` or `SBD` for a fully specified match. |
| `form_code` | Controlled HouseMeds form value. |
| `route_code` | Controlled route value; retain current route until its vocabulary is separately approved. |
| `release_type_code` | Controlled release type; never inferred only from a similar name. |
| `normalization_status` | `verified`, `needs_review`, `unmatched`, `superseded`, or `retired`. |
| `normalization_version` | Version of HouseMeds rules used for the result. |
| `terminology_version` | RxNorm release or response version used for resolution. |
| `superseded_by_id` | Optional redirect to the surviving internal medication after reviewed deduplication. |

Combination products require child component rows rather than a single flattened strength string:

| Component field | Purpose |
| --- | --- |
| `medication_id` | Parent clinical-drug identity. |
| `sequence` | Preserves the authoritative ingredient-to-strength pairing. |
| `ingredient_name` | Canonical ingredient display name. |
| `ingredient_rxcui` | Ingredient-level RXCUI when available. |
| `precise_ingredient_rxcui` | Salt or ester concept when RxNorm distinguishes it. |
| `numerator_value` / `numerator_unit_code` | Exact active-strength numerator. |
| `denominator_value` / `denominator_unit_code` | Exact denominator for concentrations; nullable for a per-unit solid. |

All numeric values use exact decimal storage, never binary floating point.

## Source aliases and match evidence

Add a `medication_aliases` or `medication_matches` table so source text is never mistaken for canonical identity. Each record should contain:

```text
source_id
listing_id
raw_name
raw_strength
raw_form
raw_route
raw_release_type
source_product_code
source_ndc
normalized_search_name
candidate_rxcuis
selected_medication_id
match_method
match_status
normalization_version
terminology_version
evidence
created_at
reviewed_at
reviewed_by
```

The raw fields and evidence are immutable observations. A later terminology update creates a new decision record or audit event instead of erasing how the earlier match was made.

## Controlled MVP values

These are the user-approved target values. Source aliases map into them, but unknown source values are not forced into a nearby category. Machine codes remain lowercase; conventional capitalization is applied only when displaying a unit.

### Form

```text
tablet
capsule
liquid
cream
ointment
gel
solution
suspension
inhaler
spray
drops
patch
injection
suppository
powder
lozenge
```

Rules:

- `tabs`, `tab`, and `tablets` can map to `tablet`; equivalent singular/plural mappings apply to other unambiguous forms.
- `liquid` is a fallback only when the evidence cannot establish `solution` or `suspension`.
- `inhaler`, `spray`, `drops`, and `injection` can be too broad to prove route or device consumption. Preserve the raw detail and require review when it affects identity or quantity.
- A dosage-form value does not establish package type. For example, a solution may be sold as a vial, bottle, syringe, or pen.

### Strength unit

| Machine code | Display label |
| --- | --- |
| `mcg` | `mcg` |
| `mg` | `mg` |
| `g` | `g` |
| `ml` | `mL` |
| `l` | `L` |
| `units` | `units` |
| `iu` | `IU` |
| `meq` | `mEq` |
| `percent` | `%` |

Rules:

- Normalize harmless spelling and typography aliases such as `μg`, `µg`, `ug`, and `microgram` to `mcg`.
- Do not assume `units` and `IU` are interchangeable unless the authoritative terminology/source establishes that equivalence.
- `mL` and `L` normally express volume or a concentration denominator. A value such as `10 mL` is not a drug strength by itself.
- Preserve ratios: `10 mg/mL` is not equivalent to `10 mg`, and `100 units/mL` is not equivalent to `100 units`.
- Convert units only with exact arithmetic and only when the basis of strength is identical. Do not remove or rewrite salts, esters, hydrates, or the RxNorm basis-of-strength substance.
- Store percentages as an exact value with `percent`; do not convert them to mass concentration without sufficient density and formulation evidence.

### Purchasable quantity unit

```text
tablet
capsule
ml
g
patch
inhaler
vial
syringe
pen
ampule
suppository
lozenge
dose
```

Rules:

- Normalize `ampoule` to `ampule` and safe singular/plural variants to the singular machine code.
- `inhaler`, `pen`, `syringe`, and `vial` are containers or devices. Preserve contained volume and labeled doses/actuations separately when available.
- `dose` is accepted only when the source explicitly prices a discrete dose and its meaning is supported by source evidence.
- Preserve nested packaging. “One box of five 3 mL pens” must retain box count, pen count, per-pen volume, and total physical volume; it must not become merely `5 dose` or `15 ml` without context.
- Unsupported units remain unresolved and exclude the listing from exact cross-source comparison.

## Medication-name normalization

Name normalization has three distinct outputs:

```text
source_name       = pharmacy text preserved unchanged
search_name       = deterministic lookup representation
canonical_name    = reviewed/RxNorm preferred display name
```

### Deterministic lookup normalization

The normalizer will:

1. Apply Unicode NFKC normalization.
2. Trim and collapse whitespace.
3. Apply locale-independent case folding for lookup.
4. Normalize punctuation and spacing around strength expressions.
5. Remove trademark glyphs from the search representation only.
6. Expand only approved, context-safe abbreviations.
7. Extract strength, form, route, and release tokens into structured fields rather than deleting them.

Source-provided structured fields take precedence over title parsing. Rendered product identity and structured product data take precedence over URL slugs. A URL slug is discovery evidence, never the sole medication identity.

The implementation must not blindly strip:

- Salt, ester, hydrate, or precise-ingredient terms such as `sodium`, `succinate`, or `tartrate`.
- Release modifiers such as `ER`, `XR`, `XL`, `SR`, `DR`, or `EC`.
- Brand names.
- Species labels.
- Combination ingredients or the association between each ingredient and its strength.

### RxNorm resolution order

1. Resolve a trustworthy source NDC to RxNorm when available.
2. Attempt an exact RxNorm string/concept lookup using structured source fields.
3. Attempt RxNorm's normalized-string lookup.
4. Use approximate matching only to populate review candidates.
5. Validate the returned concept type, active status, ingredient components, strength components, dose form, route/release implications, and brand requirement.
6. Store the selected RXCUI, normalized name, match method, terminology version, and evidence.

RxNorm is designed to provide normalized clinical-drug names and identifiers across source vocabularies. HouseMeds will use its public normalized identifiers subject to the [RxNorm terms](https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html), and will follow the [RxNorm model](https://www.nlm.nih.gov/research/umls/rxnorm/overview.html) rather than inventing synonym equivalence from pharmacy strings.

Runtime price requests must not depend on a live RxNorm call. Resolve and cache terminology during ingestion or an explicit normalization workflow. Unit tests use pinned fixtures; integration tests can exercise the live service separately.

## Match decision gates

| Outcome | Required evidence |
| --- | --- |
| Auto-link | Same active clinical-drug RXCUI and no structured-field conflict; or a previously reviewed source alias whose inputs are unchanged. |
| `needs_review` | Approximate match, multiple candidates, first-use local alias without authoritative ID, brand/generic uncertainty, unrecognized controlled value, or incomplete identity. |
| Reject/quarantine | Ingredient, component strength, form, route, release, species, NDC, or package evidence conflicts with the proposed medication. |
| Unmatched | No acceptable RxNorm concept or reviewed local canonical identity is available. |

Formatting similarity and a numeric confidence score never override a structured conflict. Confidence can prioritize a review queue, but it is not an authorization to merge.

Default comparison policy:

- Generic cross-pharmacy comparison uses the reviewed generic SCD identity.
- A brand-required product remains distinct as an SBD identity.
- A brand listing may be related to a generic concept for discovery, but it is not silently substituted into a generic comparison.
- Veterinary products remain distinct from human products and require an explicit supported-species policy.

## Database migration plan

1. **Add structures without changing reads.** Add nullable terminology/canonical fields, component rows, alias/match evidence, normalization audit events, and controlled-code checks or reference tables.
2. **Implement a versioned normalization library.** One shared fixture suite defines name cleanup, forms, strength parsing, quantity units, and match outcomes. The pricing backend owns the authoritative implementation and contract.
3. **Generate a dry-run inventory report.** Normalize every existing medication and listing without modifying IDs. Report exact duplicates, likely duplicates, conflicting candidates, unsupported values, and RxNorm coverage.
4. **Stage RxNorm resolution.** Persist candidates and evidence, but do not repoint listings during the first pass.
5. **Review ambiguity.** Resolve all collisions and dangerous near-matches before enabling automatic linking.
6. **Backfill canonical records transactionally.** Repoint verified listings to the surviving internal `medication_id`. Mark replaced IDs as `superseded` and retain redirects; do not rewrite price history or delete evidence.
7. **Enforce uniqueness.** Add a partial unique index on active `rxnorm_rxcui` values and an approved structured fallback key for records without RxNorm coverage.
8. **Switch ingestion.** New observations pass through normalization before medication upsert. Conflicts continue to quarantine the listing.
9. **Switch read/search APIs.** Return canonical IDs and structured identity fields while preserving source labels. Continue to require a verified identity for cross-source offers.
10. **Migrate `MedAPI`.** Separate local `medicineLineId` from pricing `medicationId`; require the selected canonical medication, structured strength/form, and quantity value/unit for price requests. Existing Mongo records remain readable but cannot silently receive a matched price until mapped.
11. **Retire compatibility behavior.** Remove free-text pricing lookup only after all clients use canonical IDs and the migration audit is clean.

All schema changes must be forward-only migrations with tested rollback or compensating procedures. No existing medication, listing, offer, offer-history, or household record is physically deleted during normalization.

## API contract changes

### Catalog selection

The pricing API search response should include:

```json
{
  "medication_id": "123",
  "canonical_name": "Lisinopril 20 MG Oral Tablet",
  "rxnorm_rxcui": "...",
  "ingredients": [
    {
      "name": "lisinopril",
      "numerator_value": "20",
      "numerator_unit": "mg"
    }
  ],
  "form": "tablet",
  "route": "oral",
  "release_type": "immediate",
  "normalization_status": "verified"
}
```

RXCUI remains nullable in the response because unsupported or local-only identities may exist, but only records satisfying the comparison gate can return cross-source offers.

### Household prescription input

After a user searches and selects a medication, `MedAPI` should persist and send a contract similar to:

```json
{
  "medicineLineId": "household-line-uuid",
  "medicationId": "123",
  "displayName": "Lisinopril 20 MG Oral Tablet",
  "quantity": {
    "value": "90",
    "unit": "tablet"
  }
}
```

The server resolves `medicationId` and does not trust client-submitted canonical attributes for pricing. Patient-entered dosage directions, if later supported, belong in a separate private prescription structure and never change the canonical medication identity.

If free text is accepted for UX, a normalization endpoint returns candidates for user selection. It does not silently persist the top approximate match.

## Implementation milestones

The work is intentionally divided into two milestones. Incoming normalization is completed first so new crawls and household submissions stop adding unnormalized records. Backfill then uses that frozen, tested behavior to repair existing data without maintaining two different normalization implementations.

### Milestone 1 — Incoming normalization

Scope: every new or changed pharmacy listing after cutover, and every new or updated `MedAPI` prescription medicine after its client/API migration.

Implementation status (2026-09-12): the additive schema, versioned normalizer, RxNorm resolver, source candidates, match evidence, catalog fields, `MedAPI` canonical-ID contract, and automated tests are implemented on the feature branch. The deterministic cross-service E2E and a live RxNorm compatibility check pass. The migration has not been applied to the shared database, neither service has been redeployed, and the production shadow-observation/cutover step remains pending.

The incoming MVP parses and auto-links a single validated strength or concentration. It deliberately rejects flattened combination strengths such as `100-25 mg` or `100 mg/25 mg`; those records retain their raw evidence and require structured component review. Automated combination parsing can be added only when each ingredient-to-strength pairing is obtained from authoritative structured terminology data.

Deliverables:

1. Define shared TypeScript schemas for normalized medication identity, ingredient components, form codes, strength units, quantity units, and match decisions.
2. Define the machine-code/display-label mappings and approved source aliases.
3. Create positive normalization fixtures and dangerous negative near-match fixtures.
4. Implement deterministic name, strength, form, and quantity parsing as a versioned pricing-backend library.
5. Add cached RxNorm resolution, active-concept validation, and evidence-backed match decisions. Live price reads must not depend on RxNorm availability.
6. Add the pricing database structures required for canonical/RxNorm fields, medication components, aliases/matches, redirects, audit events, and unresolved values. The migration is additive and leaves existing reads intact.
7. Add the operator decision path using `needs_review` and structured candidates; approximate matches never auto-link.
8. Update crawler ingestion so all new observations pass through the normalizer before medication upsert. Unmatched or conflicting observations remain excluded from cross-source comparison.
9. Update pricing catalog/search responses to expose the canonical medication ID and structured identity.
10. Update `MedAPI` for new and changed prescriptions: separate `medicineLineId` from pricing `medicationId`, require quantity value/unit, and resolve server-authoritative medication details from the pricing API.
11. Add contract tests spanning the pricing API and `MedAPI`.
12. Run incoming normalization in shadow mode for both pharmacies, compare its decisions with current reviewed mappings, then enable writes for one source and finally both sources.

Milestone 1 exit criteria:

- `normalization_version = 1` is frozen, deterministic, and idempotent.
- Every incoming auto-link has an accepted RxNorm/reviewed-alias basis, versions, and evidence.
- All dangerous negative fixtures remain separate.
- Unsupported or ambiguous incoming values become `unmatched` or `needs_review` rather than guessed canonical records.
- New `MedAPI` records distinguish the household line ID from canonical `medicationId`.
- An RxNorm outage pauses new resolution but does not interrupt serving already verified prices.
- Existing legacy records remain readable and unchanged; they are explicitly outside this milestone.

### Milestone 2 — Existing-data backfill

Scope: every medication, pharmacy listing, and applicable `MedAPI` record created before the Milestone 1 cutover.

Implementation status: not started. Existing production records intentionally remain legacy records until this milestone is reviewed and authorized.

Deliverables:

1. Take and verify a recoverable database backup, then restore it into an isolated environment for the first migration run.
2. Generate a read-only dry-run inventory using the exact frozen Milestone 1 normalizer. Report exact duplicates, likely duplicates, conflicting candidates, unsupported values, and RxNorm coverage.
3. Stage RxNorm candidates, structured components, match methods, versions, and evidence without repointing any listing.
4. Review every ambiguous match and collision. No fuzzy or approximate result is accepted automatically during backfill.
5. Transactionally create or select the surviving canonical medication and repoint verified pharmacy listings to it.
6. Mark replaced internal IDs as `superseded`, retain redirects, and keep raw values and decision history. Do not delete or rewrite offers, offer history, crawl evidence, or source identifiers.
7. Reconcile counts and checksums for listings, offers, offer history, and evidence before and after each batch.
8. Backfill existing `MedAPI` medicines only when the canonical match and quantity unit are unambiguous. Keep unresolved household records readable but price-unavailable until reviewed or reselected.
9. Add the active-RXCUI and approved structured fallback uniqueness constraints after all collisions are resolved.
10. Enable normalized cross-source reads for backfilled records and monitor redirects, exclusions, and comparison counts.
11. Retire free-text compatibility behavior only after all clients use canonical IDs and the backfill audit is clean.
12. Repeat the migration against a fresh production-like restore, exercise compensation procedures, and obtain approval before production execution.

Milestone 2 exit criteria:

- Every legacy row has a verified canonical mapping, an explicit unresolved/review state, or a documented out-of-scope reason.
- Approved formatting duplicates converge on one active canonical medication.
- Superseded IDs resolve to the surviving ID without breaking callers.
- Listing, offer, history, and evidence reconciliation shows no loss or silent relabeling.
- Existing household medicines are never assigned a canonical medication through an approximate match.
- Both APIs use the same canonical medication and physical-quantity semantics.
- The restored production-like migration and compensation test pass before production backfill begins.

## Test plan

Tests must be deterministic and must not require live RxNorm access. Use recorded, versioned terminology fixtures for the main suite and a separate optional live compatibility test.

Required positive cases include:

- `LISINOPRIL 20MG TAB` and `Lisinopril 20 mg tablets` resolving to the same candidate.
- Safe singular/plural form aliases.
- `μg`, `µg`, `ug`, and `mcg` formatting aliases.
- Structured concentrations such as `10 mg/mL`.
- Reviewed pharmacy aliases resolving repeatedly to the same internal ID.

Required negative cases include:

- Different strengths.
- Tablet versus capsule.
- Solution versus suspension.
- Immediate release versus ER/XR/DR variants.
- `mg` versus `mg/mL`.
- Metoprolol tartrate versus metoprolol succinate.
- Human versus veterinary products.
- Brand-required versus generic products.
- Combination drugs with a missing, reordered, or mismatched component strength.
- Percentage strengths versus unsupported inferred mass concentrations.
- One box of pens versus one pen, one vial, or one dose.

Invariant and migration tests include:

- Normalization is idempotent and locale-independent.
- Exact decimal strength conversions round-trip without loss.
- Reprocessing unchanged source data produces the same identity decision.
- Approximate matches never auto-link.
- An identity conflict cannot publish a cross-source quote.
- Repointing listings does not change offer/history totals or source evidence.
- Superseded IDs resolve to the surviving medication without creating a second active canonical record.
- Existing household records are not assigned a canonical medication without an auditable match.

## Observability and operations

Track at least:

- Normalization attempts by version and source.
- Exact RXCUI, reviewed alias, review-required, unmatched, and rejected counts.
- Duplicate canonical candidates.
- Unsupported forms, strength units, and quantity units.
- RxNorm lookup latency/failure separately from pricing collection health.
- Identity changes caused by a new normalization or terminology version.
- Cross-source listings excluded because normalization is incomplete.

An RxNorm outage must not affect serving already verified prices. It pauses new terminology resolution and leaves existing reviewed mappings intact.

## Acceptance criteria

Implementation is complete only when:

1. Every raw source value and prior identity decision remains recoverable.
2. Repeated normalization of the same input is deterministic and idempotent.
3. Approved formatting variants resolve to one canonical medication.
4. Every auto-linked listing has a recorded match method, normalization version, terminology version, and evidence.
5. No required negative fixture is merged.
6. Approximate or ambiguous matches always require review.
7. Combination ingredient-strength pairings survive normalization.
8. Controlled MVP form, strength-unit, and quantity-unit values are enforced without forcing unsupported values.
9. Existing offer counts, offer history, and source evidence are unchanged by deduplication.
10. The pricing API and `MedAPI` agree on the meaning of `medicationId`, physical quantity, and quantity unit.
11. Cross-pharmacy comparison continues to include only verified identities.
12. A restored production-like database passes the migration, rollback/compensation, API, and audit tests before deployment.

## Explicit non-goals

- Inferring or recommending a patient dosage regimen.
- Substituting one drug, strength, form, route, release type, or brand for another.
- Treating fuzzy similarity as clinical equivalence.
- Treating package quantity as dose or days supplied.
- Replacing source evidence, NDC/SKU values, or internal IDs with a mutable display string.
- Building a drug-interaction or clinical-decision system.
