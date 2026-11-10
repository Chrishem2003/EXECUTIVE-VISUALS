# Batch 68 — Runway durable task lifecycle adapter

## Why this change exists

The previous synchronous gateway combined task creation, polling and download in one call. That makes a long-running provider task hold a worker lease and makes it harder to persist task identity before polling. The gateway now exposes these steps independently so a future durable worker can store the provider task ID and resume polling after a process restart.

## New server-side adapter functions

### `submitRunwayVideoTask(...)`

- Uses the existing server-only credential and remote-execution gates.
- Builds the existing verified text-to-video or first-frame image-to-video payload.
- Sends exactly one provider POST.
- Returns the validated provider task ID, model, estimated credits and submission timestamp without polling or downloading.
- Does not implement automatic POST retries.
- If a network timeout, connection failure or provider 5xx leaves the outcome ambiguous, throws `VIDEO_GATEWAY_SUBMISSION_UNKNOWN`. The caller must reconcile; it must not blindly resubmit.

### `getRunwayVideoTask({taskId})`

- Retrieves an already-created task using its provider task ID.
- Validates task identity and known provider states.
- Returns a normalized status and output URL only after a successful task.
- Uses GET, which is safe to retry with bounded backoff.

### `downloadRunwayVideoTaskOutput({outputUrl})`

- Reuses the existing strict provider-CDN host validation.
- Streams with a 250 MiB bound.
- Validates MP4 container signature before returning bytes for private ingestion.

## Compatibility

The existing `generateRunwayVideo(...)` API remains available and is refactored to use the split submission, polling and download functions. Existing synchronous callers retain their output shape.

## Safety boundary

- No new provider call occurs on import or at server startup.
- Remote execution still requires both existing server-side enablement flags and a server credential.
- An ambiguous POST is a terminal `submission_unknown` condition for the caller until reconciled; it is not a retryable generation failure.
- Polling and output download are separate operations, so a future worker can persist task ID and resume without another POST.
- No approval is consumed, no generation queue row is created, and no payment or production configuration is changed in this batch.

## Verification

`npm run verify:runway-durable-tasks` tests one-shot submission, exactly-one POST on ambiguous outcomes, independent task polling and bounded MP4 download. The test command is included in the main build gate.
