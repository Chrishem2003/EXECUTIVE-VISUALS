# Batch 35 — Persistent Provider Rate-Card Intelligence

## Purpose
Extend the existing immutable `ai_model_price_catalog` into a versioned, evidence-aware pricing catalogue without rewriting legacy records or changing production billing.

## Schema
- Versioned rate-card identifier and explicit billing unit.
- HTTPS provider pricing source URL and source-check timestamp.
- Optional SHA-256 source fingerprint.
- Verification status distinguishes legacy-unverified, source-linked, contract-attested and admin-attested entries.
- JSON pricing dimensions for model-specific surcharges and billing conditions.
- Optional supersedes link to preserve lineage.
- Unique provider/model/currency/version index.
- Immutable insert-only records; overlapping effective periods are rejected under an advisory lock.

## API
- `GET /api/admin/finance/model-rate-cards`: owner/platform/billing admin only; optional provider, model and currency filters.
- `POST /api/admin/finance/model-rate-cards`: owner/platform/billing admin only; append a new immutable version.
- Writes use service-role RPC and the existing financial audit ledger.
- No public or customer endpoint is added.

## Evidence semantics
- Provider pricing pages are source-linked, not independently authenticated by this endpoint.
- Contract and admin-attested records require explicit matching status.
- Supplied SHA-256 fingerprints are validated for shape; bytes are not fetched or re-hashed.
- Existing records are retained as `legacy_unverified`.

## Metering boundary
The current usage-cost function can directly price tokens, images, video seconds and render seconds. Extra dimensions such as audio, reference-video seconds, resolution tiers and output formats are retained as structured metadata but are not automatically billed until the corresponding telemetry and calculation rules are implemented in a later batch. No automatic customer charge is created.

## Validation and rollout
- API authorization, validation, filter and immutable versioning tests.
- SQL migration is staged only and must be reviewed against the target Supabase schema before application.
- No production migration, deployment, provider call or billing change.
