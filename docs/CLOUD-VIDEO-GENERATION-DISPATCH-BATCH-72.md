# Batch 72 — Approval-to-cloud generation dispatch

## Outcome

The locally persisted, budget-approved video production can now be explicitly submitted to the Supabase-backed cloud queue. This closes the API integration gap between the local approval flow from Batch 66 and the durable worker/repository foundation from Batch 71.

## API

New authenticated endpoint:

`POST /api/video-production-approvals/:approvalId/submit`

The endpoint is available only when `CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED=true`. The application must also run with `AUTH_MODE=supabase`, `CLOUD_TIMELINE_API_ENABLED=true` (for authenticated job progress and asset access), and server-side `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` credentials.

The route:
1. Uses the verified authenticated user ID; it never accepts an owner ID from the request body.
2. Requires the approval to belong to that user and to a cloud project for which the user has owner/editor permission.
3. Refuses approvals with no project, withdrawn approvals, malformed snapshots, or missing idempotency/hash evidence.
4. Mirrors the existing immutable local approval into the cloud ledger using the same approval UUID, owner, project, idempotency key, request hash, quote and budget ceiling.
5. Confirms that the returned cloud approval receipt matches the local approved snapshot.
6. Calls the idempotent enqueue RPC and verifies one correctly ordered job receipt per approved shot.
7. Marks the local approval consumed only after the full queue receipt is confirmed.

A retry after a timeout uses the same approval identity and idempotency key. The cloud registration and queue RPCs are designed to return the same approval/jobs rather than creating another paid task. The endpoint does not call Runway or another model provider.

## Failure behavior

- Dispatch disabled: HTTP 503; no cloud jobs or provider requests.
- Missing cloud project: HTTP 422.
- Unauthorized project: HTTP 404 to avoid disclosing project existence.
- Non-pending local approval: HTTP 409.
- Cloud timeout: HTTP 503; local approval remains pending so the same operation can be retried.
- Registration conflict or invalid queue receipt: fail closed; local approval is not consumed.
- Rate limited to 10 submissions per authenticated user per minute.

## Separation of controls

Dispatch and provider execution are separate switches:
- `CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED=true` enables authenticated approval mirroring and queue creation.
- `CLOUD_WORKER_ENABLED=true` plus `CLOUD_VIDEO_GENERATION_WORKER_ENABLED=true` starts the worker family.
- The video worker additionally requires `VIDEO_GATEWAY_ENABLED=true`, `VIDEO_GATEWAY_ALLOW_REMOTE=true`, and a server-only `RUNWAYML_API_SECRET`.

Enabling dispatch alone does not generate a video or incur provider charges. No environment variables were changed by this code batch.

## Verification

Added:
- Unit tests for local-to-cloud approval mirroring, exact quote receipt matching, project authorization, idempotent replay, queue receipt validation and timeout retry behavior.
- HTTP route contract tests for Supabase-auth mode, dedicated feature gating, rate limiting and provider-call separation.
- Both test files are included in `verify:cloud-video-generation`, which is already part of the production build script.

## Rollout status

Code and tests are committed to the existing draft PR. The additive Supabase migration from Batch 71 remains unapplied. Dispatch remains disabled unless explicitly enabled by an operator after the isolated Supabase schema is reviewed and migrated. No production deployment, paid generation, or hosted database mutation occurred.
