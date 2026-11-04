# Runway video adapter foundation

**Branch:** `feat/runway-video-adapter`  
**Provider:** Runway Dev API  
**Initial model:** Gen-4.5 text-to-video  
**Execution state:** Disabled by default; not connected to a public application route.

## Implemented

- Server-only adapter in `server/runway-video-gateway.mjs`.
- Uses the documented `POST /v1/text_to_video` endpoint and API version header `X-Runway-Version: 2024-11-06`.
- Validates prompt length, Gen-4.5 duration (2–10 seconds), output ratio (1280:720 or 720:1280), and unsigned 32-bit seed.
- Normalizes asynchronous task states and output metadata.
- Exposes explicit task retrieval and guarded cancellation. It checks task state before DELETE so completed tasks are not accidentally deleted.
- Uses bounded request timeouts, bounded response bodies, redirect rejection, and normalized errors that do not echo provider response bodies or credentials.
- Mock-based tests cover payload validation, disabled-by-default behavior, request headers/body, task lifecycle, output URL validation, cancellation, and provider error handling.

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

The first adapter intentionally targets only Runway Gen-4.5 text-to-video: prompt length 1–1,000 characters, integer duration 2–10 seconds, and output ratio `1280:720` or `720:1280`. Seed is optional and bounded to an unsigned 32-bit integer. Image-to-video, video-to-video, model routing, and additional models are deliberately not advertised by this adapter yet. The API request schema and task lifecycle were checked against the current official API reference on 2026-11-04.

Cancellation is intentionally conservative: the adapter retrieves task state first and sends DELETE only for queued or running tasks. It never DELETEs a task already reported as succeeded, failed or canceled. Runway documents cancellation as best-effort; task execution can advance concurrently and a cancellation response does not guarantee a refund or stopped generation.
