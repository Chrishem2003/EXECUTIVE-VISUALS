# Google Omni worker registration

**Milestone:** P0.4 / P1.6 integration foundation  
**Status:** Provider registration is wired into the existing leased cloud-video worker. End-to-end Google Files/GCS/Interactions lifecycle verification is still pending.

## Runtime registration

The configured provider registry accepts an injected `googleOmniIntegration` through the existing `providerDependencies` object. Build it with `createGoogleOmniCloudVideoComposition({ assets, client, interactions, preparePlan, retentionExpiresAt })`; this binds the private output ingestor to `assets.findVideoGenerationOutput` and `assets.create`, and authorizes ingestion against the succeeded, owner/project/job-scoped durable interaction record. The worker exposes the integration's existing adapter methods, private output ingestion and task-level cost resolver through the same contract used by the other video providers.

The provider is opt-in only. All four flags must be explicitly true:

- `CLOUD_VIDEO_WORKER_ENABLED=true`
- `VIDEO_GATEWAY_ENABLED=true`
- `VIDEO_GATEWAY_ALLOW_REMOTE=true`
- `GOOGLE_OMNI_VIDEO_ENABLED=true`
- `GOOGLE_OMNI_VIDEO_ALLOW_REMOTE=true`

The last two are provider-specific. Missing or partial configuration fails closed. No provider request occurs during adapter registration.

## Required injected integration

Construct the integration using the existing `createGoogleOmniCloudVideoIntegration` factory. Its dependencies must provide:

1. A server-only Gemini Interactions client with durable approval checks and owner/project-scoped read, cancel and delete authorization.
2. The durable Google interaction repository.
3. A private output ingestor that validates the completed interaction, checks `assets.findVideoGenerationOutput({ ownerId, projectId, providerTaskId, outputIndex: 0 })` before retrying, and stores its MP4 through `assets.create` with metadata `{ source: "video-generation", providerTaskId, outputIndex: 0 }`. This reuses a previously committed output asset instead of uploading it again after a worker retry.
4. An authorized request planner that resolves private media through the Gemini Files gateway or the supported private GCS registration path.
5. An explicit interaction retention policy and task-level cost resolver.

Pass the resulting object as `providerDependencies.googleOmniIntegration` to `createProviderAwareCloudVideoWorkerComposition`, or through `videoProviderDependencies.googleOmniIntegration` to `startCloudWorkerProcess`. Pass the Files and Interactions retention workers through `startCloudWorkerProcess(env, { maintenanceWorkers: [...] })`; the supervisor runs these at a separate five-minute maintenance cadence by default, not on every media-job poll.

The worker does not infer approval from a client-side flag, accept user-supplied owner IDs, or expose provider file URLs to the browser. The Interactions POST is intentionally not retried after an ambiguous outcome; it must be reconciled through its durable interaction record.

## Interactions retention policy

The Gemini Developer API stores Interactions for 55 days by default on the paid tier and one day on the free tier. Paid-tier projects can configure AI Studio retention to 7, 14, 28 or 55 days. Set `GEMINI_OMNI_PAID_TIER_CONFIRMED=true` and set `GEMINI_OMNI_RETENTION_DAYS` to the exact value selected in AI Studio, then construct `createGoogleInteractionRetentionPolicy({ env })` and pass its `expiresAt` function as `retentionExpiresAt` to `createGoogleOmniCloudVideoIntegration`.

The policy rejects missing paid-tier confirmation and any value outside 7, 14, 28 or 55. It does not inspect or configure Google's remote setting, so staging acceptance must independently verify that the environment value matches AI Studio. The separate Gemini Enterprise Agent Platform Interactions API has a different endpoint family and retention behavior; do not mix it with the Developer API.

## Not yet accepted as complete

The repository now includes a retryable Gemini Files retention worker: it marks expired mappings as `EXPIRED`, deletes the remote Files resource, then marks the record `DELETED`. Provider 404 is treated as already deleted; transient provider or database errors leave an `EXPIRED` tombstone for the next maintenance run. The cloud-worker supervisor now supports optional scheduled maintenance tasks. These components are injectable but are not activated by default.

This integration still does not by itself prove:

- Google Drive resumable transfer recovery and private asset import/export end to end.
- Gemini Files upload, expiry, cleanup and provider-file mapping recovery.
- GCS object registration, signed access and deletion lifecycle.
- A staging run with the provider-file and Interactions retention workers scheduled and verified end to end.
- Actual task-level Google billing reconciliation.
- A staging run with approved test credentials and a real private test asset.

Keep provider flags disabled until those lifecycle tests pass in an isolated staging environment. Do not enable paid generation or production worker execution as part of this change.
