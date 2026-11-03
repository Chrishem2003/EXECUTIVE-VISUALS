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
- `POST /api/cloud/media-jobs/:id/cancel` — cancel a queued cloud media job. Requires project editor access and the `20261103160000_cancel_queued_cloud_media_jobs.sql` migration. The RPC locks the job row and records cancellation atomically; if a worker has already claimed the job, the API returns HTTP 409. Running jobs are not interrupted.
- `GET /api/cloud/assets/:id` — retrieve metadata.
- `GET /api/cloud/assets/:id/url` — create a short-lived signed download URL (5 minutes).
- `GET /api/cloud/assets/:id/file` — authenticated redirect to a short-lived signed URL, with private/no-store response headers; used by the browser asset preview.
- `DELETE /api/cloud/assets/:id` — soft-delete metadata, then remove the exact private object; HTTP 202 means cleanup remains pending.
- `POST /api/cloud/assets/:id/retry-cleanup` — retry removal for a previously deleted asset.

Uploads are streamed to a temporary file, size-checked, signature-checked, checksum-verified during cloud upload, and the temporary file is removed on success or failure. The cloud asset repository authorizes owner/project roles before storage access and compensates for failed metadata writes by removing the uploaded object.

## Current boundary

The browser asset workspace uses this API when the health endpoint reports `cloudAssets.enabled` and `cloudAssets.configured`; cloud media-job routing additionally requires `cloudJobs.enabled` and `cloudJobs.configured`. Uploads, listings and previews then use cloud asset IDs and signed file redirects. The local `/api/assets` path remains the fallback when the feature flag is off. Cloud media jobs use the Postgres `jobs` queue consumed by the separately deployed cloud media worker; the local SQLite queue remains independent. Worker progress is written through a lease-fenced RPC, is monotonic, and produces durable `job.progress` events. The workspace refreshes active cloud jobs every five seconds while the browser tab is visible. Queued cancellation is serialized against worker claims. Do not enable cloud mode for end users until the dedicated database/storage migrations (including progress and cancellation RPCs) are applied and hosted authorization, upload limits, preview redirects, signed-link expiry, queue insertion, progress reporting and real worker execution are tested. The health endpoint reports whether the bridge is enabled/configured; that is not proof of hosted project readiness.
