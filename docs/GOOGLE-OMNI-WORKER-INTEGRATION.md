# Google Omni worker registration

**Milestone:** P0.4 / P1.6 integration foundation  
**Status:** Provider registration is wired into the existing leased cloud-video worker. End-to-end Google Files/GCS/Interactions lifecycle verification is still pending.

## Runtime registration

The provider-aware worker composition now constructs `googleOmniIntegration` when all four explicit gates are true: `GOOGLE_OMNI_VIDEO_ENABLED`, `GOOGLE_OMNI_VIDEO_ALLOW_REMOTE`, `GEMINI_OMNI_ENABLED`, and `GEMINI_OMNI_ALLOW_REMOTE`. The host must inject `googleOmniAssertApprovedSubmission`, `googleOmniAuthorizeInteraction`, and `googleOmniPreparePlan`; optional `googleOmniClient`, `googleOmniInteractions`, `googleOmniRetentionExpiresAt`, and `googleOmniAuthorizeOutputIngestion` overrides are available for controlled environments. The default client and durable interaction repository are created server-side from the worker's Supabase credentials and Gemini API key. The planner must resolve private references to authorized Google Files URIs and return an approval-required plan. The approval callback must verify the persisted budget approval/reservation and leased job lineage; the interaction authorizer must verify owner/project/job scope. Missing governance callbacks fail worker construction closed. Build it with `createGoogleOmniCloudVideoComposition({ assets, client, interactions, preparePlan, retentionExpiresAt })`; this binds the private output ingestor to `assets.findVideoGenerationOutput` and `assets.create`, and authorizes ingestion against the succeeded, owner/project/job-scoped durable interaction record. The worker exposes the integration's existing adapter methods, private output ingestion and task-level cost resolver through the same contract used by the other video providers.

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


### Large generated-video retrieval

Gemini Omni URI delivery is required for generated videos. The Interactions API guide documents that the output URI is available in the initial response or streaming events, while a later full interaction retrieval can include the video as inline base64. The worker therefore requests a partial response for polling using `fields=id,model,status,steps(type,content(type,mime_type,uri))`, excluding the `data` field. If the URI is present in the filtered response, it then downloads the Google Files URI separately with a bounded streaming reader and commits bytes to the private Cloud Asset repository. Important limitation: Google's current Omni guide guarantees the URI in the initial creation response or SSE stream, but does not guarantee that a later GET contains it. The field mask is therefore only a payload-reduction attempt, not proof that URI retrieval works for every background interaction; a staging test must verify the actual response. The durable production path must capture the URI from a create/GET SSE stream and persist it before relying on Files API polling.

The REST client also bounds interaction response reads while streaming; it cancels the response body once the configured limit is exceeded, before JSON parsing. This is a defensive cap, not a substitute for URI delivery. If the Interactions endpoint does not honor the field mask, polling fails closed with `GEMINI_OMNI_RESPONSE_TOO_LARGE`; do not increase the response cap to accommodate base64 video. Verify field-mask behavior against a paid-tier staging project before enabling remote generation.
