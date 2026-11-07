# Runway cloud-worker operation contract

**Status:** implemented behind explicit configuration gates; not production-enabled.

This document describes the Runway operations added to the provider-aware cloud worker. Provider API documentation is not proof that the account has access to every model or that an adapter is safe to enable.

## Registered model profiles

| Model | Operation | Output | Source requirement |
|---|---|---|---|
| `gen4.5` | Text-to-video | MP4 | Prompt |
| `gen4.5` | First-frame image-to-video | MP4 | Owner-scoped image asset |
| `aleph2` | Video-to-video | MP4 | Owner-scoped source video; optional up to five ordered keyframes |
| `magnific_video_upscaler_creative` | Video upscale | MP4 | Owner-scoped source video; probed duration and frame count |
| `ruby` | SDR-to-HDR | HDR10 or HLG MP4 | Owner-scoped SDR source; probed dimensions and duration |

The adapter rejects all other model/operation combinations. Video-to-video keyframes must be strictly ordered, at most five, and within the supported 30-second source window. Upscale controls are bounded and model-specific. HDR currently accepts only HDR10/HLG MP4 output; ProRes and EXR are not routed through the MP4-only private ingestor.

## Explicit server-side gates

All of these must be deliberately configured before remote execution can happen:

- `CLOUD_VIDEO_WORKER_ENABLED=true`
- `VIDEO_GATEWAY_ENABLED=true`
- `VIDEO_GATEWAY_ALLOW_REMOTE=true`
- `RUNWAY_VIDEO_ALLOW_REMOTE=true`
- `RUNWAY_API_KEY` (or the existing `RUNWAYML_API_SECRET`)
- `RUNWAY_VIDEO_MODELS` as a comma-separated allowlist of verified model profiles
- An injected authoritative `resolveRunwayActualCost` implementation for provider task settlement
- The built-in owner/project-scoped private source resolver, which reads only authorized cloud assets through short-lived Supabase signed URLs and server-probes source media with FFprobe. An injected resolver may replace it for a controlled integration.
- The same resolver supplies server-probed duration, frame count, dimensions and dynamic-range metadata for budget preflight. An injected metadata resolver may replace it for a controlled integration.

No Runway model is registered by default. The worker composition rejects source-operation registration if source resolution or verified metadata resolution is absent.

## Resolver contracts

### `prepareRunwayInput(input, context)`

The callback must authorize the job owner against the source asset and project before reading any bytes. It returns only the media required for the requested operation:

- Image-to-video: `{ firstFrame: { buffer, filename, mimeType } }` or a validated Runway ephemeral `promptImageUri`.
- Video-to-video: `{ sourceVideo: { buffer, filename, mimeType }, keyframes: [{ buffer, filename, mimeType, at }] }` or equivalent already-created Runway ephemeral URIs.
- Upscale/HDR: `{ sourceVideo: { buffer, filename, mimeType } }` or a validated Runway ephemeral `videoUri`.

Never accept arbitrary client-supplied URLs or raw object paths. The callback must resolve asset IDs using the existing authorization boundary. Uploaded Runway URIs are ephemeral (24 hours) and must not be stored as permanent media URLs.

### `resolveRunwaySourceMetadata({ ownerId, projectId, assetId })`

This callback must verify the exact owner, project and asset ID, then return server-probed metadata:

```js
{
  ownerId,
  projectId: null, // or the exact project UUID
  assetId,
  mediaType: "video/mp4",
  durationSeconds: 11.2,
  frameCount: 336, // required for Magnific
  sourceDynamicRange: "sdr", // required for Ruby
  sourceWidth: 1920, // required for Ruby
  sourceHeight: 1080 // required for Ruby
}
```

The enqueue boundary verifies the identity tuple and compares the request duration/frame count to the server-probed values. Duration is rounded up for pricing. Ruby rejects non-SDR inputs and missing/invalid dimensions. Do not source these values from browser input or user-editable metadata.

### `resolveRunwayActualCost(task)`

Must reconcile authoritative provider billing evidence for the persisted task ID and return the actual amount, currency and a stable evidence reference. A preflight estimate, submitted estimated credits, or local multiplier is not settlement evidence. Unknown task outcomes must be reconciled before retrying.

## Worker and asset lifecycle

1. Budget preflight runs before enqueue and reserves against the dated provider price snapshot.
2. Worker resolves source ownership and media metadata, uploads authorized input to Runway ephemeral storage, then submits the provider task.
3. The provider task ID is persisted through the existing submission ledger.
4. Worker polls under renewable leases; it does not hold one worker lease while waiting for a long generation.
5. Successful output is downloaded, validated as MP4, and ingested into private project storage as a derivative.
6. Actual provider cost is reconciled and settled against the reserved amount.
7. Original source assets remain immutable. Output URLs from Runway are temporary and never become permanent application asset references.

## Release gates

- [ ] Dependency PRs #53, #57 and #58 are reviewed and integrated in order.
- [ ] Current-head Quality checks pass, including typecheck and full test suite.
- [ ] Disposable PostgreSQL integration passes.
- [x] Built-in private source resolver implemented with owner/project authorization, signed-URL origin checks, bounded downloads, integrity checks and server-side FFprobe metadata tests.
- [ ] Staging source resolver acceptance against real private test assets.
- [ ] Runway account entitlement and current model IDs are verified.
- [ ] Provider billing resolver reconciles task-level usage and handles unknown outcomes.
- [ ] Output host allowlist, MP4 validation and private storage ingestion are verified in isolated staging.
- [ ] Credit reservation/settlement and cancellation semantics are tested.
- [x] Product UI exposes budget approval and paid submission controls, with submission disabled unless all eight server readiness gates pass.
- [ ] Timestamped keyframe input controls are exposed in the product UI.
- [ ] Explicit production approval is recorded before any model is enabled.

## Safety

No live provider generation, paid API request, production deployment, Render configuration change, database migration or payment transaction is performed by CI. Keep all model availability disabled until the complete release gates are satisfied.

## Official API references

- Runway API reference: https://docs.dev.runwayml.com/api/
- Ephemeral uploads: https://docs.dev.runwayml.com/assets/uploads/
- Pricing: https://docs.dev.runwayml.com/guides/pricing/
