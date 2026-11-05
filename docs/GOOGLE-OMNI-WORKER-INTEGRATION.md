# Google Omni worker registration

**Milestone:** P0.4 / P1.6 integration foundation  
**Status:** Provider registration is wired into the existing leased cloud-video worker. End-to-end Google Files/GCS/Interactions lifecycle verification is still pending.

## Runtime registration

The configured provider registry accepts an injected `googleOmniIntegration` through the existing `providerDependencies` object. The worker exposes the integration's existing adapter methods, private output ingestion and task-level cost resolver through the same contract used by the other video providers.

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
3. A private output ingestor that validates the completed interaction and stores its MP4 in the existing private asset system.
4. An authorized request planner that resolves private media through the Gemini Files gateway or the supported private GCS registration path.
5. An explicit interaction retention policy and task-level cost resolver.

Pass the resulting object as `providerDependencies.googleOmniIntegration` to `createProviderAwareCloudVideoWorkerComposition`, or through `videoProviderDependencies.googleOmniIntegration` to `startCloudWorkerProcess`.

The worker does not infer approval from a client-side flag, accept user-supplied owner IDs, or expose provider file URLs to the browser. The Interactions POST is intentionally not retried after an ambiguous outcome; it must be reconciled through its durable interaction record.

## Not yet accepted as complete

This registration layer does not by itself prove:

- Google Drive resumable transfer recovery and private asset import/export end to end.
- Gemini Files upload, expiry, cleanup and provider-file mapping recovery.
- GCS object registration, signed access and deletion lifecycle.
- Interactions retention scheduling and deletion recovery.
- Actual task-level Google billing reconciliation.
- A staging run with approved test credentials and a real private test asset.

Keep provider flags disabled until those lifecycle tests pass in an isolated staging environment. Do not enable paid generation or production worker execution as part of this change.
