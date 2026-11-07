# Provider-aware cloud video worker

**Status:** source-integrated and test-gated; remote execution remains disabled by default. No provider API request, paid generation, deployment or live migration is performed by CI.

## What is included

- Durable Supabase queue, submission ledger, budget approvals and reservations.
- Exact provider/model adapter routing; unknown combinations fail closed.
- FAL asynchronous queue adapter with provider task status and task-level billing reconciliation.
- Runway Dev text/image-to-video, Aleph 2 video editing, Magnific upscaling and Ruby HDR adapter profiles.
- Owner/project-scoped private source resolution, short-lived signed URLs, bounded downloads, media probing and private derivative ingestion.
- Leases, heartbeat/recovery, idempotency, provider task reconciliation and private output validation.
- Gemini Omni Flash Interactions adapter, durable interaction ownership/retention metadata and private output ingestion. Google Omni worker registration requires injected approval, owner/project authorization and private-input planning callbacks; it is not enabled by the default worker process.

## Default safety posture

All cloud worker and remote provider flags remain false in `.env.example`. The default process does not start a provider worker and does not submit remote work.

To run the FAL worker in an isolated staging environment, configure only after the database migrations, private bucket and FFmpeg/FFprobe are verified:

- `CLOUD_WORKER_ENABLED=true`
- `CLOUD_VIDEO_WORKER_ENABLED=true`
- `VIDEO_GATEWAY_ENABLED=true`
- `VIDEO_GATEWAY_ALLOW_REMOTE=true`
- `FAL_VIDEO_MODEL` set to one exact FAL endpoint
- `FAL_KEY` and `FAL_BILLING_KEY` in the server secret manager
- `CLOUD_VIDEO_OUTPUT_HOSTS` as a comma-separated, narrow hostname allowlist
- `SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY`
- FFmpeg and FFprobe installed on the worker host

Never put provider credentials or the service-role key in browser configuration. The cloud worker must run as a separate worker service, not inside the public web process.

## Runway-specific gates

Runway models are available as adapter code but are not registered by the default worker process. Do not set `RUNWAY_VIDEO_MODELS` until an authoritative task-level actual-cost resolver is implemented and verified. The provider's estimated credits are not treated as settlement evidence. Runway supports asynchronous task submission and polling; outputs are temporary and must be ingested into private storage before durable use.

## Gemini Omni-specific gates

The Gemini Omni Flash adapter uses the Interactions API and durable interaction metadata. Before enabling it, the host must inject:

- a durable approval assertion for each paid submission;
- owner/project authorization for every interaction read, poll, cancel and delete;
- a private-input planner that resolves only authorized asset IDs;
- a verified Gemini paid-tier retention setting that matches AI Studio;
- provider task-level cost evidence and output ingestion authorization.

The integration composition rejects missing callbacks and requires both the Google Omni and Gemini transport flags. The default cloud worker process does not provide these application-specific callbacks; therefore Google Omni remains disabled until a reviewed staging composition supplies them.

## Migrations and verification

Additive migrations in this branch:

- `20261104120000_cloud_video_submission_ledger.sql`
- `20261104143000_cloud_video_budget_enqueue.sql`
- `20261105120000_google_video_interactions.sql`
- Four Google Drive connection, OAuth-state and export-attempt migrations.

GitHub Actions applies these to a disposable PostgreSQL 16 service and checks queue/budget invariants, Google interaction ownership/retention, encrypted Drive credentials and export lease integrity. This is not evidence that any staging or production database has been migrated.

## Release acceptance checklist

- [ ] Exact-head quality checks and all unit tests pass.
- [ ] Disposable PostgreSQL migrations and integration scripts pass.
- [ ] Isolated staging schema and private bucket are provisioned and independently reviewed.
- [ ] FAL account/model entitlement, billing API and output host allowlist are verified.
- [ ] Staging verifies approval, owner/project isolation, retries, unknown provider outcomes, budget reservation/settlement, cancellation and private output checksums.
- [ ] Runway task-level actual-cost reconciliation is implemented before any Runway model is enabled.
- [ ] Gemini approval, owner/project callbacks, retention agreement and paid-cost reconciliation are supplied and tested before Google Omni is enabled.
- [ ] Google OAuth/Picker import/export is accepted with real test accounts and revoked-token cases.
- [ ] Subscription checkout, webhook idempotency, entitlement enforcement and refunds are accepted with the selected merchant.
- [ ] Explicit production approval is recorded before applying migrations, setting production secrets or deploying.

## Official references

- Runway API: https://docs.dev.runwayml.com/api/
- Runway models and capability constraints: https://docs.dev.runwayml.com/guides/models/
- Gemini video generation and Interactions workflows: https://ai.google.dev/gemini-api/docs/video
- FAL queue status and result retrieval: https://fal.ai/docs/model-apis/model-endpoints/queue
