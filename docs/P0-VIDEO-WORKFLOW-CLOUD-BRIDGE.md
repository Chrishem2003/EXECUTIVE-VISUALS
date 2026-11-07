# P0 Video Workflow Cloud Bridge — execution boundary

## Current behavior

The interactive `video.generate` workflow node still uses the existing synchronous Runway/FAL gateways and local generated-asset persistence. The durable provider-aware cloud video queue is a separate execution surface; this document does not claim that the surfaces are integrated.

## Fail-closed mode selector

`server/video-workflow-execution-mode.mjs` defines the explicit workflow execution mode:

- `legacy` (default): preserves the existing behavior while the bridge is unfinished.
- `cloud`: currently rejects with `CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED` before identity checks, private-asset reads, budget reservations or provider submission.
- Any other value rejects with `VIDEO_WORKFLOW_EXECUTION_MODE_INVALID`.

This prevents an operator from assuming that setting a cloud-mode flag will route Studio workflow nodes through the durable worker. It deliberately does not add a second queue or pretend to provide hosted generation.

## Additional integration finding

The repository contains a Runway Model Router adapter with a non-billable `preflight()`, durable routing metadata on submit, task polling, private output ingestion and actual-cost resolution from the completed task's realized `cost.credits`. This is valuable existing infrastructure and should be reused rather than reimplemented.

The application enqueue layer recognizes the logical `runway/model-router` identity behind explicit remote, worker, saved-config and USD budget gates, and the worker composition contains the router adapter. However, the source-controlled PostgreSQL function `enqueue_video_generation_job` still only allows `runway/gen4.5` and `google/gemini-omni-1.1-flash`; the worker's default `runwayModels` allowlist also omits `model-router`. The router is therefore not end-to-end enqueueable through the current SQL/worker contract. Enabling it requires a reviewed migration and explicit worker model registration, then disposable-PostgreSQL tests. Do not work around this by changing only the application allowlist.

## Required work before cloud mode can be enabled

1. Add an authenticated customer API for quote, exact-input approval, enqueue, status and cancellation.
2. Bind the quote and approval to the authenticated actor, tenant, project, canonical request hash, provider/model/operation, private asset IDs and expiry.
3. Validate ownership, media type, checksum, duration, size and project scope server-side before enqueue.
4. Atomically reserve customer credits and provider budget; idempotently enqueue using the existing durable queue and submission ledger.
5. Map durable job state into workflow run/node state and publish stable private asset IDs for downstream timeline nodes.
6. Settle only from provider-authoritative realized usage; reconcile ambiguous submission, cancellation, partial output and refunds without double charging.
7. Add disposable-PostgreSQL end-to-end tests for tenant isolation, replay, idempotency, retry/recovery, no legacy fallback and downstream asset consumption.
8. Complete isolated staging acceptance, rollback and operational runbooks before enabling the mode.

## CI integration finding

The current GitHub Actions quality workflow originally targeted only pull requests whose base is `main`. PR #211 targets the integration branch, so its changes did not receive the repository's full quality workflow. The workflow trigger now includes both `main` and `integration/omni-provider-workers-2026`, and pushes to that integration branch. This ensures feature PRs stacked on the integration branch can receive the same typecheck/build checks. Confirm the workflow actually triggers on the next push before treating CI as active.

## Verification

The existing `verify:workflow-executor` build step now asserts:
- explicit legacy mode remains compatible;
- cloud mode fails closed with the stable bridge-not-configured code;
- unknown modes fail closed.

These policy tests do not constitute end-to-end cloud workflow acceptance. Paid generation and production deployment remain disabled until the full bridge is implemented and accepted.
