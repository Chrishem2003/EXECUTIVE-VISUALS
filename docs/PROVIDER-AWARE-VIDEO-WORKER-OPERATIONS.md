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


## Research update — Runway Model Router and revenue controls (2026-11-07)

The current Runway Dev documentation adds a potentially useful alternative to the direct-task billing path described above:

- Model Router can submit video generations through `POST /v1/generate/video` using a saved router configuration. It can filter eligible models, optimize for cost/latency/quality, enforce a per-generation credit ceiling, and optionally fall back when a model is at capacity.
- A `dryRun: true` request returns the routing decision and estimated credit cost without creating a task or billing a generation. This is suitable for a pre-dispatch quote/approval screen, not for final settlement.
- The documented successful live Model Router response includes routing metadata for the selected model/provider/configuration and the realized generation cost in credits. That is a stronger candidate for task-correlated cost evidence than the direct task's estimated-cost field.
- The routed request history endpoint is useful for reconciliation, but its documented list schema exposes `estimatedCredits`; do not silently treat that field as actual settlement.
- The existing `server/runway-router-dry-run.mjs` is intentionally non-billable and currently does not implement live routed submission. The current direct Runway adapter still requires an injected task-level cost resolver.

### Required implementation before any paid routed generation

1. Add a separate Model Router adapter; do not change the existing direct Runway adapter's accounting assumptions.
2. Preserve the exact live submission response's validated routing metadata in the durable submission ledger in the same atomic record operation as the provider task ID. A process-local cache is not acceptable because workers restart and leases are recovered.
3. Add a schema migration and RPC contract for immutable submission metadata; restrict writes to the service role and bind metadata to job, owner, request hash, task ID, router config and provider/model.
4. Validate the provider-documented realized-cost field and currency/credit conversion against a versioned Runway credit price snapshot. If the response omits or changes that field, quarantine the completed task and keep the budget reservation held.
5. Keep dry-run estimate and live realized cost as separate evidence types. The user-facing estimate must be labelled as an estimate; settlement must use only the validated live response metadata and a traceable evidence reference.
6. Add deterministic tests for malformed/missing metadata, mismatched task IDs, unknown response versions, replayed submissions, worker restart after submission, lease recovery, cost above reservation, failed/cancelled tasks and idempotent settlement.
7. Keep the new adapter disabled by default. No API key, router configuration, provider request or paid generation is created by this change.

Official references:
- Model Router generation and dry-run semantics: https://docs.dev.runwayml.com/model-routers/generating/
- API reference and routed request/task endpoints: https://docs.dev.runwayml.com/api/
- Current model pricing and credit rates: https://docs.dev.runwayml.com/guides/pricing/

## Uganda subscription collection clarification (2026-11-07)

Flutterwave's current Uganda documentation lists UGX card and Uganda mobile-money collection. Its payment-plan documentation describes automatic recurring charges using a customer's saved card details. Do not advertise recurring MTN/Airtel mobile-money debits as supported without separate written provider confirmation.

Recommended product design:
- Monthly/yearly auto-renewing subscription: card payment plan, after merchant approval and sandbox lifecycle testing.
- MTN/Airtel Mobile Money: one-time UGX credit top-ups or one-time purchases, verified server-side.
- Keep subscription entitlements and generation-credit purchases as separate ledger concepts.
- Before launch, verify fees, taxes, refunds, chargebacks, webhook retries, payout settlement and account eligibility using the merchant's actual Uganda account.

Official references:
- Payment plans: https://developer.flutterwave.com/docs/payment-plans-1
- Uganda payment methods: https://developer.flutterwave.com/docs/payment-methods
- Uganda mobile money: https://developer.flutterwave.com/docs/uganda
- Uganda pricing: https://www.flutterwave.com/ug/pricing


## Runway Model Router adapter foundation (2026-11-07)

A separate opt-in adapter now exists at `server/runway-model-router-video-adapter.mjs`. It targets the documented `POST /v1/generate/video` and `GET /v1/tasks/{id}` API, validates the router slug, task ID, routing configuration, selected model/provider and HTTPS output URLs, and returns the routing decision as provider submission metadata.

The shared executor now persists provider submission metadata in the existing Postgres submission ledger in the same record operation as the provider task ID. When a worker resumes a submitted job after restart, it passes the durable metadata to the provider cost resolver. Metadata is bounded below the existing 8 KB ledger constraint. This prevents the route decision from existing only in process memory.

### Explicit activation boundary

The new adapter is disabled by default and is not yet registered in the worker composition or customer enqueue path. That is deliberate:

- The existing enqueue path requires an approved, server-computed budget reservation before dispatch. The Model Router must first be integrated with a non-billable dry-run quote on the exact same input, then bind the approved credit ceiling to the job. A live generation must never be started from a dry-run estimate alone.
- Runway's current public docs describe the live response as including realized cost in credits, but the published JSON schema does not identify a stable property path for that realized-cost value. The adapter therefore requires an injected `resolveRealizedCredits` contract and will hold settlement if the resolver cannot return a finite non-negative realized-credit amount. Do not guess a response property or fall back to `estimatedCost.credits`.
- The adapter converts validated realized credits to USD using the published $0.01 per Runway credit rate. The job's approved USD reservation must cover that amount. The provider-selected model is persisted in the cost result.
- Private input resolution, allowed output hosts, output ingestion, user authorization, router config management, request idempotency/reconciliation and per-user budget approval must be wired before enabling the adapter.
- Do not add `model-router` to the public capability catalogue or expose it in customer UI until the enqueue preflight, budget approval and runtime registration paths are complete and tested together.

Tests added for adapter gates, durable route metadata, realized-credit settlement, missing evidence, mismatched router config, task polling and HTTPS output validation. CI must pass before considering the adapter ready. No Runway API key, router configuration, paid generation or production deployment was created by this code change.

Official contracts:
- https://docs.dev.runwayml.com/model-routers/generating/
- https://docs.dev.runwayml.com/api/
- https://docs.dev.runwayml.com/guides/pricing/


### Runway task-cost contract correction (2026-11-07)

The current Runway Dev integration guide and API reference now make the billing lifecycle explicit:

- Router dry-run: `routing.estimatedCost.credits` is an estimate only. A dry-run creates no task and charges no generation credits.
- Live task creation: the returned task includes `estimatedCost.credits`, the maximum it may charge.
- Completed task: `GET /v1/tasks/{id}` reports `cost.credits`, the realized charge. This is the authoritative settlement field.
- Routed task metadata identifies the selected model, provider, config and routing settings. The adapter stores that routing evidence with the durable task submission record.
- The adapter now exposes a `preflight(input)` method which hardcodes `dryRun: true`, rejects unexpected task IDs, and returns a non-billable quote with the selected model and estimate.
- Settlement now reads only the completed task's `cost.credits`, validates it against the task's `estimatedCost.credits` ceiling, and uses the selected model from the durable route evidence. It does not accept estimates as realized cost.

The public customer API still needs to call this preflight method behind authenticated project/asset authorization, persist the quote and expiry, and bind the exact input hash plus maximum credit ceiling to the user's explicit approval before enqueue. Until that API and approval binding are complete, the adapter remains unregistered and remote execution remains off by default.

References:
- https://dev.runway.com/learn/add-ai-video-generation-to-your-app
- https://docs.dev.runwayml.com/api/
- https://docs.dev.runwayml.com/model-routers/generating/

## Runway Dev November 5 model release — verified price and capability update

The current official changelog and pricing table were rechecked on 2026-11-07.

- Kling 4.0 Flash: 720p, 3–20 seconds, audio included; up to 10 images including first frame and 5 videos with a combined 20-second video-input budget. Pricing is 9.4 credits/output-second without input video, or 6.3 credits/output-second plus 6.3 credits for each second of max(combined input video, output duration) with input video; total rounded up, 29-credit minimum.
- Gemini Omni 1.2 Flash: 3–15 seconds at 360p/720p/1080p/4K; text, image/keyframe and video workflows, including edit and extension. Rates are 2/7/10/21 credits per output second by resolution, plus 1 credit per reference image/keyframe and 1 credit per input-video second; total rounded up, 6-credit minimum.
- GPT Image 2.6 Flare and Sunburst: image-only endpoints. Their pricing is quality/resolution/aspect-ratio dependent (1–19 credits/image), plus one credit per reference image per generated output. They require a separate image adapter and estimator.

The registry and deterministic preflight estimator now encode the ordinary video-generation formulas and tests. All new model entries remain disabled and non-executable. Do not treat preflight estimates as invoices or settlement evidence. Gemini Omni 1.2 auto-duration reserve/settlement and edit/extend-specific billing require mode-aware adapter work before those operations can be sold. Kling Flash video-to-video requires source duration to be provided to the estimate path. No live paid API calls or provider activation are part of CI.

Source of truth:
- https://docs.dev.runwayml.com/api-details/api_changelog/
- https://docs.dev.runwayml.com/guides/pricing/

