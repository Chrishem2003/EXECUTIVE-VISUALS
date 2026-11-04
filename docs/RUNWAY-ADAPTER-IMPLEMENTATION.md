# Runway video adapter foundation

**Branch:** `feat/runway-video-adapter`  
**Provider:** Runway Dev API  
**Initial model:** Gen-4.5 text-to-video and image-to-video  
**Execution state:** Disabled by default; not connected to a public application route.

## Implemented

- Server-only adapter in `server/runway-video-gateway.mjs`.
- Uses the documented `POST /v1/text_to_video` and `POST /v1/image_to_video` endpoints with API version header `X-Runway-Version: 2024-11-06`.
- Accepts the shared provider-neutral video-generation contract, then maps declared Runway Gen-4.5 capabilities: prompt length, 2–10 second duration, text-to-video 16:9/9:16, image-to-video 16:9/9:16/4:3/3:4/1:1/21:9, first-frame asset ID, and unsigned 32-bit seed. Unsupported options fail before any network request.
- Normalizes asynchronous task states and output metadata.
- Exposes explicit task retrieval and guarded cancellation. It checks task state before DELETE so completed tasks are not accidentally deleted.
- Uses bounded request timeouts, bounded response bodies, redirect rejection, and normalized errors that do not echo provider response bodies or credentials.
- Image-to-video requires an injected server-side asset resolver. The adapter passes owner ID, project ID and private asset ID to that resolver, and accepts only an HTTPS asset URI or Runway upload URI; browser-supplied arbitrary URLs are never used as first-frame assets.
- `server/runway-private-asset-resolver.mjs` implements that resolver contract: it loads an owner/project-scoped private asset, checks visibility, image MIME, filename, size and PNG/JPEG/WebP file signature, then creates a Runway ephemeral upload and returns the `runway://` URI. Uploads are prepared before the provider-submission ledger enters its one-shot submitting state, so a failed upload cannot be mistaken for an ambiguous generation POST.
- Mock-based tests cover payload validation, disabled-by-default behavior, both endpoint request bodies, owner/project-scoped asset resolution, task lifecycle, output URL validation, cancellation, and provider error handling.

## Safety boundary

The adapter requires both `RUNWAY_VIDEO_ENABLED=true` and `RUNWAY_VIDEO_ALLOW_REMOTE=true`, plus a server-side `RUNWAY_API_KEY`. No key belongs in browser code, client configuration, repository files, or chat. The model is fixed to the initially verified `gen4.5` contract; unsupported model settings fail closed.

No real provider request, account configuration, credential entry, generation, or paid execution has been performed.

## Not yet implemented

- Durable application job-queue integration, leases, retries, idempotency and cancellation reconciliation.
- Pre-submit cost approval/reservation and post-submit usage ledger recording.
- Secure ingestion of ephemeral Runway output URLs into private project storage with checksum and media probing.
- API routes, UI controls, provider catalog exposure, and role/consent checks.
- Browser workflow and hosted acceptance tests.

Do not advertise this adapter as a user-facing working generation feature until those integrations and release gates pass. Runway task polling should be no more frequent than every five seconds. Completed output URLs are temporary; the platform must ingest them into private storage rather than expose them directly to users.

## Official API references

- https://docs.dev.runwayml.com/api/
- https://docs.dev.runwayml.com/guides/using-the-api/
- https://docs.dev.runwayml.com/assets/outputs/

## Initial request contract

The adapter targets Runway Gen-4.5 text-to-video and image-to-video through the shared `normalizeVideoGenerationRequest` / `assertVideoCapabilities` contract: prompt length 1–1,000 characters, integer duration 2–10 seconds, text-to-video aspect ratio 16:9 or 9:16, image-to-video aspect ratios 16:9, 9:16, 4:3, 3:4, 1:1 or 21:9, an optional first-frame asset ID for image-to-video, and optional unsigned 32-bit seed. Negative prompts, audio-mode overrides, extra reference assets, end frames, non-default resolution, video-to-video editing, model routing, and additional models fail closed until their exact model contracts are implemented. The API request schema and task lifecycle were checked against the current official API reference on 2026-11-04.

Cancellation is intentionally conservative: the adapter retrieves task state first and sends DELETE only for queued or running tasks. It never DELETEs a task already reported as succeeded, failed or canceled. Runway documents cancellation as best-effort; task execution can advance concurrently and a cancellation response does not guarantee a refund or stopped generation.
