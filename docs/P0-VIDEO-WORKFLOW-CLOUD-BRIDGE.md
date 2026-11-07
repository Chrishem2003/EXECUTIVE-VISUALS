# P0 Video Workflow Cloud Bridge — execution boundary

## Current behavior

The interactive `video.generate` workflow node still uses the existing synchronous Runway/FAL gateways and local generated-asset persistence. The durable provider-aware cloud video queue is a separate execution surface; this document does not claim that the surfaces are integrated.

## Fail-closed mode selector

`server/video-workflow-execution-mode.mjs` defines the explicit workflow execution mode:

- `legacy` (default): preserves the existing behavior while the bridge is unfinished.
- `cloud`: currently rejects with `CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED` before identity checks, private-asset reads, budget reservations or provider submission.
- Any other value rejects with `VIDEO_WORKFLOW_EXECUTION_MODE_INVALID`.

This prevents an operator from assuming that setting a cloud-mode flag will route Studio workflow nodes through the durable worker. It deliberately does not add a second queue or pretend to provide hosted generation.

## Required work before cloud mode can be enabled

1. Add an authenticated customer API for quote, exact-input approval, enqueue, status and cancellation.
2. Bind the quote and approval to the authenticated actor, tenant, project, canonical request hash, provider/model/operation, private asset IDs and expiry.
3. Validate ownership, media type, checksum, duration, size and project scope server-side before enqueue.
4. Atomically reserve customer credits and provider budget; idempotently enqueue using the existing durable queue and submission ledger.
5. Map durable job state into workflow run/node state and publish stable private asset IDs for downstream timeline nodes.
6. Settle only from provider-authoritative realized usage; reconcile ambiguous submission, cancellation, partial output and refunds without double charging.
7. Add disposable-PostgreSQL end-to-end tests for tenant isolation, replay, idempotency, retry/recovery, no legacy fallback and downstream asset consumption.
8. Complete isolated staging acceptance, rollback and operational runbooks before enabling the mode.

## Verification

The existing `verify:workflow-executor` build step now asserts:
- explicit legacy mode remains compatible;
- cloud mode fails closed with the stable bridge-not-configured code;
- unknown modes fail closed.

These policy tests do not constitute end-to-end cloud workflow acceptance. Paid generation and production deployment remain disabled until the full bridge is implemented and accepted.
