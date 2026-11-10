# Batch 23 — Rendering Economics & Shadow Model Routing

## Objective
Measure the real resource footprint of Executive Visuals workloads, attach cost evidence to customer/project/job records, and produce model-routing recommendations without changing live provider execution.

## Implemented
- FFmpeg child-process wall-clock measurement in the shared media runner.
- Measurements propagate through direct media jobs, timeline rendering and workflow-executed media nodes.
- Worker measurement events are buffered and persisted after job execution through the financial API; telemetry persistence failures are logged and do not fail the creative job.
- Resource rate cards are effective-dated, currency-specific, source-referenced and immutable.
- Resource cost events distinguish provider-reported actuals, rate-card estimates and unpriced measurements.
- Resource economics overview groups costs by resource type/provider, customer and job; it exposes unpriced events.
- Model performance evidence links one evaluation to one successful usage-cost event and records latency, quality score, evaluation source and version.
- Shadow routing compares candidates only when at least 20 recent (30-day) observations have provider-reported actual cost plus linked quality/latency evidence.
- Candidate constraints include maximum actual cost, p95 latency and minimum quality. Recommendations are scored with quality 60%, cost 25% and latency 15%.
- Every routing decision is append-only, idempotent and explicitly records `decisionMode=shadow_only` and `executionChanged=false`.
- PostgreSQL integration tests cover rate-card calculation, resource-event replay, unpriced GPU telemetry, resource overview, model-evidence aggregation and shadow recommendation replay.

## API
- `POST /api/admin/finance/resource-rates`
- `POST /api/admin/finance/resource-usage`
- `GET /api/admin/finance/resource-economics?periodMonth=YYYY-MM-01`
- `POST /api/admin/finance/model-performance`
- `POST /api/admin/finance/model-routing/shadow`

All public API routes require a finance administrator role. Worker telemetry uses a server-side-only method and a separately configured finance-system actor; no service-role credential is exposed to media workers or clients.

## Measurement truth
- `ffmpeg_second` is the measured wall-clock duration of each FFmpeg child process. It is not CPU time, GPU time, or video duration.
- Multiple FFmpeg invocations for one job are separately recorded and can be aggregated by job ID.
- GPU seconds, CPU seconds, storage retention and egress are supported resource categories but are not fabricated or emitted without real telemetry.
- Shared infrastructure costs are not allocated without a defensible measured driver.
- Resource estimates require a currency-specific, effective-dated rate card. Missing rates or currency remain unpriced.
- Model-routing cost comparisons use provider-reported actual inference costs only. Catalog estimates do not qualify as actual-cost evidence.
- Quality evidence must identify human review or an approved evaluator and a version. The system does not infer quality from completion status.

## Staged activation
Worker persistence is fail-closed and requires all of:
- `BILLING_API_ENABLED=true` with the existing verified Supabase-auth configuration;
- `RESOURCE_COST_METERING_ENABLED=true`;
- `FINANCIAL_SYSTEM_ACTOR_ID` set to an existing finance administrator UUID;
- `RESOURCE_COST_CURRENCY` set to the intended reporting currency if rate-card estimates are desired.

No production environment variables are changed by this PR. Without these settings, FFmpeg timing is measured in-process but not sent to the financial ledger. Resource rate cards must be populated from verified provider invoices or cloud contracts before estimates are treated as meaningful.

## Explicitly not enabled
- No automatic provider/model switching, live fallback, customer price change or billing mutation.
- No claim of GPU telemetry where the worker does not expose it.
- No automatic cloud invoice download or cloud-provider account connection.
- No production migration, deployment, merge or paid infrastructure.
- The monthly finance review automation could not be created because the account currently has three active scheduled tasks and has reached its limit; no existing automation was changed.

## Validation
The Batch 23 CI workflow applies Batch 21, Batch 22 and Batch 23 migrations in order, runs disposable PostgreSQL integration scripts, checks server-module syntax and runs the financial API/unit tests. Exact-head CI must pass before merge or production rollout.
