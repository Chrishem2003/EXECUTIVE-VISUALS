# Batch 21 — AI Cost Intelligence & Margin Optimization

## Delivered foundation
- Versioned, immutable provider/model rate cards with effective dates, currency and source provenance.
- Append-only per-operation usage/cost events attributed to provider, model, customer, project and job.
- Usage dimensions for input/output tokens, images, generated video seconds and render seconds.
- Three explicit cost bases: provider-reported actual, versioned-catalog estimate and unpriced.
- Admin-protected cost intelligence overview by provider/model/operation and customer.
- Invoice import and invoice-line evidence tables with unique keys and explicit matching/review states.
- Database-level administrator authorization, row-level security and append-only audit evidence.
- No prompts, completions, media bytes, API keys or provider credentials in usage records.

## Cost truth rules
1. Provider-reported billed amounts are the strongest per-operation cost evidence.
2. Catalog prices create estimates only; they never masquerade as invoice-confirmed charges.
3. Missing pricing remains unpriced; zero-cost inference is prohibited.
4. Invoice totals and line items remain separate until reconciled.
5. Currency totals are never combined.
6. Customer attribution is recorded only when trusted execution context supplies owner/project/job IDs.
7. Shared GPU, render, storage and network overhead remains unallocated until a measured driver exists.
8. Failed and cancelled operations remain visible because providers may bill them.

## Database interfaces
- record_ai_usage_cost_event writes an idempotent usage event, preferring provider-reported cost and otherwise applying the effective versioned rate card.
- ai_cost_intelligence_overview reports provider/model/operation and customer evidence, plus unpriced-event counts.
- ai_model_price_catalog stores input/output token rates per million, per-image, per-video-second and per-render-second rates.
- ai_provider_invoice_imports and ai_provider_invoice_lines preserve invoice source evidence and future reconciliation state.

## Integration gates not claimed complete
This migration establishes durable data structures and trusted database functions. It does not yet claim automatic provider invoice downloads, CSV parsing, provider adapter instrumentation, GPU telemetry collection, intelligent routing or anomaly notification. Those require provider-specific credentials, execution hooks, verified invoice formats, thresholds and staging acceptance tests.

No production migration, merge, deployment, provider activation or paid infrastructure change is performed by this batch. Apply only in the dedicated disposable PostgreSQL integration environment before any deployment decision.
