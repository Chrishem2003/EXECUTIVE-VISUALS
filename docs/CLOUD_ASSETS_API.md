# Private cloud asset API

The application includes an opt-in cloud asset API bridge. It is disabled by default and does not replace the existing local asset library or local worker queue.

## Enable only on an isolated staging service

Required server-side environment:

- `AUTH_MODE=supabase`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` for user authentication
- `SUPABASE_SERVICE_ROLE_KEY` for server-side private storage and metadata access
- `CLOUD_ASSETS_ENABLED=true` for the dedicated cloud asset API routes.
- `CLOUD_TIMELINE_API_ENABLED=true` for cloud projects, timelines and cloud media-job submission/listing. This flag performs a startup schema/readiness check.
- `CLOUD_MEDIA_MAX_UPLOAD_BYTES` (bounded by the storage adapter to at most 1 GiB)

The service role key is used only by the server-side cloud asset adapter. Never expose it in frontend configuration, API responses, logs, or source control.

Before enabling the flag, apply the reviewed Executive Visuals core migration to a dedicated Supabase project. Confirm the `executive_visuals` schema, the `assets`, `projects`, and `project_members` tables, and the private `executive-visuals-media` bucket exist. Add `executive_visuals` to the Supabase Data API exposed schemas and confirm the service role has schema/table privileges. The migration is not automatically applied by the API.

## Routes

All routes require a verified Supabase access token in the Authorization header.

- `GET /api/cloud/assets?projectId=<uuid>&limit=50&offset=0` — list authorized private assets.
- `POST /api/cloud/assets` — stream a raw media body; set `Content-Type`, `X-File-Name`, and optional `X-Project-Id` headers.
- `POST /api/cloud/media-jobs` — enqueue an allowlisted cloud media operation using `{ projectId, sourceAssetId, jobType, options }`; send an `Idempotency-Key` header (at least 8 characters). The API resolves the source under the verified user and project, pins its SHA-256 in the immutable job input, and derives `owner_id` from the verified session.
- `GET /api/cloud/media-jobs?projectId=<uuid>` — list supported cloud media jobs visible to authorized project members.
- `GET /api/cloud/media-jobs/:id/events?projectId=<uuid>&limit=50` — inspect bounded, project-authorized event history for one cloud media job. The API returns only `job.*` events and a sanitized allowlist of event metadata; the UI loads history on demand rather than polling every job.
- `POST /api/cloud/media-jobs/:id/cancel` — cancel queued jobs or request cooperative cancellation of running jobs. Requires project editor access and the queued/cooperative cancellation migrations. Running workers poll under their active lease, abort supported media processes, and finish as cancelled; database transitions make accepted requests win races with success or retry.
- `GET /api/cloud/assets/:id` — retrieve metadata.
- `GET /api/cloud/assets/:id/url` — create a short-lived signed download URL (5 minutes).
- `GET /api/cloud/assets/:id/lineage` — authorized source ancestry (bounded to 12 levels) and up to 100 direct derivatives, constrained to the same owner/project scope.
- `GET /api/cloud/assets/:id/file` — authenticated redirect to a short-lived signed URL, with private/no-store response headers; used by the browser asset preview.
- `DELETE /api/cloud/assets/:id` — soft-delete metadata, then remove the exact private object; HTTP 202 means cleanup remains pending.
- `POST /api/cloud/assets/:id/retry-cleanup` — retry removal for a previously deleted asset.

Uploads are streamed to a temporary file, size-checked, signature-checked, checksum-verified during cloud upload, and the temporary file is removed on success or failure. The cloud asset repository authorizes owner/project roles before storage access and compensates for failed metadata writes by removing the uploaded object.

## Current boundary

The browser asset workspace uses this API when the health endpoint reports `cloudAssets.enabled` and `cloudAssets.configured`; cloud media-job routing additionally requires `cloudJobs.enabled` and `cloudJobs.configured`. Uploads, listings and previews then use cloud asset IDs and signed file redirects. The local `/api/assets` path remains the fallback when the feature flag is off. Cloud media jobs use the Postgres `jobs` queue consumed by the separately deployed cloud media worker; the local SQLite queue remains independent. Worker progress is written through a lease-fenced RPC, is monotonic, and produces durable `job.progress` events. The workspace refreshes active cloud jobs every five seconds while the browser tab is visible. Queued cancellation is serialized against worker claims. Do not enable cloud mode for end users until the dedicated database/storage migrations (including progress and cancellation RPCs) are applied and hosted authorization, upload limits, preview redirects, signed-link expiry, queue insertion, progress reporting and real worker execution are tested. The health endpoint reports whether the bridge is enabled/configured; that is not proof of hosted project readiness.


Running cancellation uses `cancel_requested_at` and `cancel_requested_by` on the job record. The `request_media_job_cancellation` RPC records an auditable event; `check_job_cancellation` only returns a request to the current unexpired lease owner. Worker completion and retry RPCs enforce cancellation precedence. Apply the cooperative-cancellation migration only in an isolated staging project after schema review; it has not been applied to any hosted database.


Derivative lineage is read from the `derivative_of` relationship. The API verifies the requested asset and read permission first, walks source ancestry with a hard depth cap, and lists only active direct derivatives in the same project (or personal-library scope). Missing/deleted/cross-scope parents are not disclosed; cycles fail closed. This endpoint is metadata-only and does not create signed media URLs.


### Worker process observability

The cloud worker supervisor emits structured lifecycle and periodic `health` log records. Snapshots include process status, enabled worker-family count, start time, last cycle/recovery timestamps, cycle count, claimed-job count, recovered-job count, active-cycle/recovery flags, and bounded error counters/codes. Snapshots deliberately exclude worker credentials, environment values, asset contents, user identifiers, and raw error messages. Treat this as process-level telemetry, not proof that the database, storage, or a particular queued job is healthy; correlate it with the hosting platform's process health and the durable project-scoped job/event APIs. The in-memory counters reset on process restart.
