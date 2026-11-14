# Gemini Omni hosted worker integration

This batch connects the existing Gemini Omni adapter to the separate cloud worker. It does not enable remote generation by default.

## Supported path

- Text-to-video generation.
- First-frame image-to-video using an existing private asset.
- Reference image/video generation using existing private assets.
- Video edit and extension from an existing private asset.
- Conversational edit/extension using a prior Gemini interaction owned by the same user and project.

The worker uploads private inputs through the Gemini Files gateway only after it verifies the active worker lease, durable submission ledger and consumed budget reservation. Provider files are temporary and are not substitutes for the original private assets.

Last-frame locking is deliberately rejected by this path until the input contract and provider task semantics are implemented and tested.

## Required operator gates

Every flag defaults to false:

- `CLOUD_WORKER_ENABLED=true`
- `CLOUD_VIDEO_WORKER_ENABLED=true`
- `VIDEO_GATEWAY_ENABLED=true`
- `VIDEO_GATEWAY_ALLOW_REMOTE=true`
- `GOOGLE_OMNI_VIDEO_ENABLED=true`
- `GOOGLE_OMNI_VIDEO_ALLOW_REMOTE=true`
- `GEMINI_OMNI_ENABLED=true`
- `GEMINI_OMNI_ALLOW_REMOTE=true`
- `GEMINI_OMNI_PAID_TIER_CONFIRMED=true`
- `GEMINI_OMNI_WORKER_ENABLED=true`
- `GOOGLE_OMNI_CONNECTION_STATUS=connected`

Also required:

- Server-only `GEMINI_API_KEY` (or `GOOGLE_GEMINI_API_KEY`).
- Isolated Executive Visuals Supabase URL and service-role key.
- The reviewed cloud video, budget approval, submission ledger and Google interaction migrations.
- Private `executive-visuals-media` object storage and the reviewed cloud media authorization policies.
- FFmpeg and FFprobe on the separate worker.
- Explicit `CLOUD_VIDEO_OUTPUT_HOSTS` allowlist.

Do not add the key to browser/Vite variables. Do not enable these gates on the existing Render web service until the separate worker, database and storage have passed staging acceptance.

## Approval and execution sequence

1. The enqueue RPC consumes a short-lived user approval and creates the budget reservation atomically.
2. The worker claims the job with a lease token.
3. The submission ledger moves the job into the prepared state.
4. Before any private media is uploaded to Gemini, the worker verifies the lease, job scope, consumed approval, matching provider/model/request hash, and reserved amount against the durable reservation and approval rows.
5. The provider adapter builds a bounded plan from owner/project-scoped assets and active Gemini Files references.
6. Immediately before the provider POST, the worker verifies the lease and submission ledger again. The client independently validates the durable approval.
7. The interaction ID and owner/project/job lineage are stored durably. Ambiguous submission outcomes are quarantined for reconciliation; the worker never blindly retries a potentially accepted POST.
8. Completed output is ingested into the private Executive Visuals asset store. Actual provider token usage must reconcile before budget settlement.

The worker performs a non-generation Google model metadata GET to verify the configured API key. It does not submit a generation request during startup or connection verification.

## Verification

- `npm run verify:batch:10` includes Gemini Files lifecycle and Gemini Omni worker dependency tests.
- `npm run verify:server:shard:03` covers worker process configuration and lifecycle behavior.
- PostgreSQL CI verifies the cloud video enqueue and approval/reservation contracts.

No production migration or environment change is included in this batch. The operator must run the full staging acceptance path before enabling any remote execution gate.
