# Gemini Omni Flash — reverse-engineered integration contract

Research snapshot: 2026-11-05. Sources are Google's current Gemini API documentation. This branch adds server-side Files API upload and GCS registration gateways, durable interaction state, a cloud-worker adapter, private output ingestion, usage-based cost reconciliation and retention cleanup. All live generation remains disabled.

## Critical migration finding

Google shut down the Gemini API Veo 3.1 Preview endpoints on October 22, 2026. Google recommends Gemini Omni Flash (`gemini-omni-1.1-flash`) for general video generation and conversational editing, or GA Veo models through the Gemini Enterprise Agent Platform. Do not route new Gemini API traffic to the retired preview model IDs.

## Current API shape

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- Authentication: server-side Google API key via `x-goog-api-key` (injected only by the live server adapter)
- Model: `gemini-omni-1.1-flash`
- Input: text or multimodal content parts (image/video URI plus text)
- Output: `response_format: { type: "video", aspect_ratio, resolution, delivery }`
- Aspect ratios: 16:9 and 9:16
- Resolutions: 360p, 720p (default), 1080p and 4k (upscaled)
- Output length: 3–10 seconds per generation; extensions can add up to 10 seconds, up to 40 seconds total
- Stateful edits: `previous_interaction_id`
- Raw REST video output: `steps[].content[]` with `type: "video"`, `mime_type: "video/mp4"`, and either `data` (base64) or `uri`
- URI delivery is recommended for outputs larger than 4 MB; Google-hosted files must be polled until ACTIVE before download.

## Media and limitations

- Uploaded source videos for editing/extension are limited to 10 seconds.
- Up to three reference video clips are supported, each up to three seconds.
- Audio from reference videos is ignored.
- Audio-reference uploads are not supported.
- Generated videos include native audio.
- Negative prompts, system instructions, temperature, and top-p are not supported.
- Video extension appends to the end; it cannot prepend or extend the middle.
- Editing or extending uploaded videos has regional availability restrictions (EEA, Switzerland and UK); generated-video multi-turn edits remain supported.
- Outputs include SynthID provenance watermarking.

## Implementation

- `server/google-gemini-files-gateway.mjs` uploads already-authorized private assets using Google's resumable Files API; the original remains in Executive Visuals storage.
- `server/google-gemini-signed-url-resolver.mjs` creates short-lived, owner/project-authorized Supabase Storage signed URLs for Gemini Interactions. For supported images and videos up to 100 MB, Gemini fetches the original private object directly; the application server does not download or re-upload the media bytes. The signed URL is request-scoped and is not stored in provider-file mappings.
- `server/google-gemini-files-repository.mjs` stores private provider-file mappings and their source provenance.
- `server/google-gemini-gcs-registrar.mjs` registers allowlisted `gs://` objects with `files:register` without downloading or copying source bytes; it uses injected OAuth credentials and expires its local cache after 29 days.
- `server/google-video-interaction-repository.mjs` persists interaction ID, owner/project/job scope, request hash, lineage, state and application expiry without storing media bytes.
- `server/google-omni-flash-client.mjs` provides approval-gated create, authorized retrieval, cancellation and deletion; ambiguous create POSTs are never blindly retried.
- `server/google-omni-private-output-ingestion.mjs` downloads or decodes completed output and commits it to private asset storage.
- `server/google-omni-cloud-video-adapter.mjs` bridges the existing lease-aware cloud-video executor, durable submission ledger and private output ingestor. It is implemented but remains disabled at provider selection and enqueue.
- `server/google-interaction-retention-worker.mjs` deletes expired stored interactions with a retryable deleting state and idempotent handling of provider 404 responses.
- `server/google-omni-pricing.mjs` uses Google's published paid-tier token prices. Preflight reserves the maximum 1,048,576-token input context plus a ten-second 720p video output ($2.586464 USD). Actual settlement uses provider-returned `usage.total_input_tokens` and `usage.total_output_tokens`; missing usage is a hard failure, never a guessed charge.
- The Interactions client requires three independent flags: `GEMINI_OMNI_ENABLED=true`, `GEMINI_OMNI_ALLOW_REMOTE=true`, and `GEMINI_OMNI_PAID_TIER_CONFIRMED=true`. All remain disabled unless explicitly configured.
- `supabase/migrations/20261105100000_google_provider_files.sql` and `20261105133000_google_gcs_file_registration.sql` add service-role-only private provider-file mappings and source provenance.
- `supabase/migrations/20261105120000_google_video_interactions.sql` adds a service-role-only, forced-RLS interaction ownership ledger tied to cloud jobs, users and projects.
- `server/google-omni-flash-interaction.mjs`
  - Builds a pure request plan for the Interactions API.
  - Uses only private asset IDs, authenticated owner/project context, and a server-side Google Files URI resolver.
  - Requires stateful `previous_interaction_id` references to resolve to a stored interaction owned by the same user and project, and pinned to the same model.
  - Rejects arbitrary URLs and malformed Google Files URIs.
  - Enforces source/reference video duration limits.
  - Supports first/last frame interpolation and previous-interaction lineage.
  - Normalizes the documented raw REST `steps` response, not the SDK-only `output_video` convenience property.
  - Caps inline response size and recommends URI delivery for large outputs.
  - Does not send requests, load credentials, upload media, or download outputs.
- `server/video-provider-registry.mjs`
  - Updates current Omni capabilities, official pricing metadata and constraints.
  - Keeps the provider disabled while marking the adapter implemented but not yet wired to the hosted worker process.
- `server/tests/google-omni-flash-interaction.test.mjs`
  - Covers request planning, project authorization, media URI validation, durations, response normalization and failure cases.

## Executive Visuals integration boundary

The Google adapter now conforms to the shared leased video executor and provides a provider-usage settlement resolver. However, the normal enqueue path still rejects Google jobs, and the cloud worker process does not yet compose the Google client, asset resolver, private output ingestor and approved-budget callbacks. Provider selection therefore remains disabled. The pricing implementation is available for preflight/settlement testing but does not authorize paid generation.

This provider should plug into the shared video generation contract and durable cloud worker lifecycle. A live adapter must not be enabled until the app can guarantee:

1. Authenticated owner/project authorization for every input asset and every `previous_interaction_id` lineage reference.
2. Explicit user approval and a durable budget reservation before POST.
3. One-shot idempotent submission (never retry a POST after an ambiguous timeout without reconciliation).
4. Durable interaction ID and state tracking.
5. Private ingestion of Google-hosted output before user delivery.
6. Output validation, actual-cost reconciliation, audit evidence and retention/cleanup.
7. Region-aware gating for uploaded-video editing/extension.
8. Verified Google billing evidence and model pricing before enqueue accepts the Google provider.
9. A configured retention policy consistent with the project's Gemini API tier and AI Studio log-retention setting.

Google API credentials must remain server-side. The planner returns only the authentication header name and a server-only credential-source marker; it never handles or returns a credential.

## Google Cloud Storage registration

Google's Gemini Files API supports `POST /v1beta/files:register` for GCS objects. The registration does not copy the object; Google reads the original GCS object. The Gemini API Service Agent must have `Storage Object Viewer` on each approved bucket. This is an operator-managed IAM prerequisite; this branch does not create IAM grants.

The registrar requires:
- `GOOGLE_CLOUD_PROJECT_ID` for quota attribution.
- `GEMINI_GCS_ALLOWED_BUCKETS` as a server-side exact bucket allowlist.
- An injected OAuth token provider with `devstorage.read_only` and `cloud-platform` scopes.
- An authorized GCS-backed private asset resolver returning owner/project metadata, object URI, byte size and SHA-256.
- A durable mapping repository. The registration cache expires after 29 days, below Google's maximum 30-day access window.

Current Executive Visuals Supabase Storage assets are not silently treated as GCS objects. A GCS-backed asset adapter and explicit bucket IAM provisioning are required before this path can be used.

## Private Supabase Storage signed-URL input

Google's file-input documentation now supports external HTTPS and signed URLs for Interactions, including private cloud storage objects, with a 100 MB request limit. The implementation uses this path for supported image/video media only:

- Asset lookup and signed URL creation run through the existing Cloud Asset Service, which checks owner/project read access.
- The resolver requires the exact configured Supabase origin and the `executive-visuals-media` signed-object path.
- It rejects unsupported MIME types, missing/incorrect asset metadata, URLs with extra query parameters, and files over 100 MB.
- Signed URLs expire after 10 minutes by default (configurable from 60 to 3600 seconds) and are never written to logs or durable provider-file mappings.
- The planner rejects signed URLs with less than 30 seconds remaining at submission time.
- Larger files continue to use the Gemini Files API resumable upload gateway or the separate GCS registration path; the GCS path still requires operator-managed bucket IAM.

This is an optimization path, not a change to provider availability. Google Omni remains disabled and remote execution remains approval-gated.
