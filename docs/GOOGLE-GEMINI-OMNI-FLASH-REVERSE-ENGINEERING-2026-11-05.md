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

## Google Drive private file bridge

A separate Google Drive bridge supports private file import and export using per-user OAuth. It requests only the non-sensitive `drive.file` scope, which is designed for files a user explicitly selects or shares with the application (normally through Google Picker). It does not request broad access to the user's entire Drive.

Implementation:
- `server/google-drive-private-file-bridge.mjs` imports a user-selected Drive file into the existing owner/project-scoped private Cloud Asset Service.
- Imports verify Drive file ID, trash/download capability, supported MIME type, declared size, downloaded byte count and returned content type before writing to private storage.
- Exports first load and re-authorize the private asset, verify owner/project, bucket, MIME type, size and SHA-256, then use Drive's resumable upload protocol.
- OAuth access tokens are injected by a host-side per-user connection store, fetched on demand, and never persisted by this module.
- Destination folder IDs are accepted only as opaque Drive IDs; Drive remains responsible for enforcing the connected user's actual folder permissions.
- Google-native Docs/Sheets/Slides exports are not silently converted. The current bridge handles binary media/document types already supported by the private asset service.
- Upload-session URLs are restricted to Google's HTTPS Drive upload hosts and paths. Redirects are disabled; ambiguous uploads are not blindly retried.

The bridge is a server-side adapter, not yet a complete user-facing Google OAuth + Picker integration. Before enabling it, the hosted application must add OAuth consent/callback and encrypted refresh-token storage, Google Picker file selection, connection ownership checks, and per-user token refresh/revocation. No Drive token or live Drive API call was used in these tests.

Official Google references:
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/identity/protocols/oauth2/scopes


## Google Drive OAuth and private connection foundation

The follow-on implementation adds a server-side Google account connection flow. It is deliberately disabled unless `GOOGLE_DRIVE_OAUTH_ENABLED=true` and requires `AUTH_MODE=supabase`.

New server modules:
- `server/google-drive-oauth.mjs`: state-bound authorization-code + PKCE flow, OIDC nonce validation, Google RS256 identity-token signature verification using Google's published JWK set, encrypted refresh-token envelopes (AES-256-GCM), refresh-token rotation, access-token caching and disconnect/revocation.
- `server/google-drive-connection-store.mjs`: service-role-only Supabase persistence for encrypted refresh-token metadata and atomic one-time OAuth state consumption. State values are SHA-256 hashed; PKCE verifier and OIDC nonce are encrypted at rest.
- `server/index.mjs`: authenticated connect, status and disconnect endpoints plus a state-bound callback that does not depend on a cross-site SameSite=Strict session cookie.

New endpoints:
- `POST /api/integrations/google-drive/connect` — returns a Google authorization URL for the authenticated user.
- `GET /api/integrations/google-drive/callback` — consumes one-time state, validates the callback and redirects to the application.
- `GET /api/integrations/google-drive/status` — returns connected state, account email and granted scopes (never tokens).
- `POST /api/integrations/google-drive/disconnect` — attempts Google token revocation and always removes the local connection record.

Required server configuration (only when intentionally enabling this feature):
- `AUTH_MODE=supabase`
- `GOOGLE_DRIVE_OAUTH_ENABLED=true`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI` (must exactly match the Google Cloud OAuth client; callback path is `/api/integrations/google-drive/callback`)
- `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` (at least 32 characters; keep outside source control)
- `GOOGLE_PICKER_API_KEY` (restricted to the staging web origin and Google Picker APIs)
- `GOOGLE_CLOUD_PROJECT_NUMBER` (numeric Google Cloud project number used by Picker)
- Existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

Two source-controlled migrations add:
- `google_drive_connections`: per-user encrypted refresh token, verified Google subject/email and granted scopes.
- `google_drive_oauth_states`: hashed one-time state, encrypted PKCE verifier/nonce and short expiry.

Both tables force RLS and revoke access from public, anon and authenticated roles; only the server service role is granted access. These migrations have **not** been applied to any Supabase environment. The OAuth feature remains disabled by default.

Security details:
- The OAuth callback resolves its owner exclusively from the one-time server-side state record created after an authenticated connect request; the callback does not trust a user ID from query parameters.
- The callback validates state ownership/expiry, PKCE verifier, OIDC nonce, token scopes, ID-token issuer/audience/expiry/email verification and RS256 signature.
- Refresh tokens are AES-256-GCM encrypted before persistence; the raw token is never returned by the API or stored in the connection table.
- OAuth state is consumed with one atomic database DELETE, preventing callback replay across application instances.
- Google Drive permission remains limited to `drive.file` plus OpenID/email identity scopes.

Remaining integration work:
- Google Picker frontend and API-key/app-ID configuration.
- UI connection status, connect/disconnect actions and import/export progress.
- Wire the OAuth access-token provider into the private Drive bridge and expose authenticated import/export endpoints.
- Validate the full flow against a dedicated staging Google OAuth client after environment variables and migrations are reviewed.
- Add scheduled cleanup for expired OAuth state rows.

This is server-side OAuth infrastructure, not yet the complete user-facing Drive file picker. Do not enable it or apply migrations until the staging configuration, Google Cloud consent screen, callback URI and secret storage have been reviewed.

- The OAuth coordinator is now composed with the private Drive bridge in `server/index.mjs`. When explicitly enabled, the server also composes the existing private Cloud Asset Service and downloads export candidates only through short-lived Supabase signed URLs; the downloaded bytes are size- and SHA-256-verified before Drive upload.
- Additional authenticated endpoints: `POST /api/integrations/google-drive/import` accepts a Picker-selected `fileId` and optional `projectId`; `POST /api/integrations/google-drive/export` accepts a private `assetId`, optional `projectId` and optional destination `parentFolderId`.
- Import and export endpoints use the authenticated application user as the owner, never accept an owner ID from the request, and are rate-limited. Import is bounded by the configured cloud media upload limit.
- The Settings screen now has Google Drive connection status, connect and disconnect controls. The Picker itself remains the next frontend milestone; the import endpoint is ready for the Picker's selected file ID.

Google Picker frontend follow-up:
- The Settings screen now exposes a "Choose files from Drive" action when a connection exists.
- The client obtains a short-lived access token from the authenticated `POST /api/integrations/google-drive/picker-token` endpoint. The token is scoped to the user's selected-file `drive.file` access and is not persisted in localStorage.
- Picker selection sends only the selected file ID to the authenticated import endpoint; the server independently verifies access and file metadata before ingesting bytes.
- The server Content Security Policy now explicitly allows the Google API loader, Picker frames and required Google API connections. Review the staging web origin and API key referrer restrictions before enabling.

- The Cloud project asset register now exposes two Drive export destinations: save directly to the user's Drive root, or use Google Picker's folder view to choose a destination folder. The server still validates the selected folder ID and relies on Drive to enforce the connected user's permissions.

Drive picker upload follow-up:
- The authenticated Drive picker now includes both a filtered existing-file view and Google's device-upload view. A user can upload a local file into their own Drive from the picker and then import the selected file into the app's private project asset store.
- OAuth remains limited to the per-file `drive.file` scope (plus OpenID identity scopes); no full-Drive access is requested.
- This is separate from the Gemini Files API gateway, which uploads private app assets to Google's temporary Files service for model execution. Both upload paths remain disabled until staging credentials and explicit feature flags are configured.

Budgeted enqueue hardening:
- The shared cloud-video enqueue boundary now recognizes the exact Google provider/model pair only when `GEMINI_OMNI_ENABLED`, `GEMINI_OMNI_ALLOW_REMOTE`, `GEMINI_OMNI_PAID_TIER_CONFIRMED` and `GEMINI_OMNI_WORKER_ENABLED` are all explicitly `true`.
- The direct Gemini API preflight remains restricted to 720p/provider-default until the API pricing contract for other output resolutions is verified. The reservation is USD 2.586464, covering a full 1,048,576-token input context plus a 10-second 720p output at 5,792 tokens/second. This is a conservative maximum, not an invoice.
- The Postgres enqueue function independently enforces the Google model, 3–10 second duration, 720p-only budget tier and minimum reservation. The existing budget policy, approval consumption, idempotency and service-role-only RPC boundaries remain in force.
- PostgreSQL integration tests now create a Google budget policy and verify successful queueing, under-reservation rejection and unsupported-resolution rejection. They do not call Google's generation API.
