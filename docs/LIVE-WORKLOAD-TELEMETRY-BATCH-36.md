# Batch 36 — Live Workload Telemetry & Multidimensional Cost Attribution

## What is recorded
- Provider/model/operation identity, timestamp, project/job/customer attribution and evidence source.
- Multimodal usage dimensions: audio tokens, cached and reasoning tokens, image counts, reference-video seconds, generated-video seconds, render seconds, upscale images and processed frames.
- Operational dimensions: accepted/rejected outputs, retry and attempt counts, latency, CPU/GPU seconds, storage and egress.
- Resolution tier and optional provider-reported cost with explicit currency.
- Resource type/unit/quantity for existing worker resource measurements.

## Architecture
- `normalizeWorkloadTelemetry` validates bounded numeric dimensions and rejects prompt/media content fields.
- `POST /api/admin/finance/workload-telemetry` records explicitly supplied evidence for financial administrators.
- `GET /api/admin/finance/workload-telemetry` provides period-scoped aggregate reporting.
- Existing local worker measurement flush now records workload telemetry alongside the existing resource-cost event.
- Service-role RPC validates administrator/system actor, idempotency, attribution, evidence source and dimension keys.
- Append-only table, immutable trigger, RLS and audit-ledger event preserve evidence.

## Accounting boundaries
- Dimensions are usage counters, not monetary values.
- Provider cost is populated only when explicitly reported with currency.
- Worker resource measurements do not become provider charges.
- No missing usage or customer attribution is inferred.
- Prompt, generated text, media bytes, API keys and credentials are not stored.

## Release
- Migration is staged and not applied to any Supabase environment.
- CI and unit/API tests are configured.
- No production deployment or provider invocation is part of this batch.
