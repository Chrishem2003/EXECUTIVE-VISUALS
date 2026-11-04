# Google Gemini Files API — private upload gateway

Research and implementation snapshot: 2026-11-05.

## Status

- PR #48 supplies the Gemini Omni Flash request planner and response normalizer.
- This branch adds the server-side resumable Files API upload gateway and a service-role-only Postgres mapping repository.
- All remote execution remains disabled. Tests use mocked fetch only; no Google API key or live upload is used.
- The gateway is not yet composed into the cloud worker or application upload route.

## Security model

1. The browser submits only an Executive Visuals private asset ID and the selected project context.
2. The server's private asset loader must authenticate and authorize the caller and verify owner/project scope.
3. The loader must return an asset from the private `executive-visuals-media` bucket, with verified size, MIME type and SHA-256 metadata, plus a cleanup callback.
4. The gateway uploads bytes to Google using a server-side `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY`. The key and resumable session URL are never returned to the browser.
5. The resulting Google file name, URI, MIME type, size, hash, owner, project and expiry are persisted in `executive_visuals.google_provider_files`.
6. Only the service role can read or mutate this mapping table. Authenticated browser roles receive no table grants.
7. The Gemini URI is accepted by the Omni request planner only when resolved from an authorized private asset ID. Arbitrary browser-supplied URLs remain rejected.

## Resumable upload lifecycle

- Initiate `POST /upload/v1beta/files` with `X-Goog-Upload-Protocol: resumable` and `X-Goog-Upload-Command: start`.
- Validate that Google's `x-goog-upload-url` is HTTPS and on the exact Google API origin.
- Transfer bounded chunks with explicit offsets and finalize the final chunk.
- Poll `GET /v1beta/files/{id}` until the file reaches `ACTIVE`; fail closed for `FAILED` or processing timeout.
- Persist a mapping with a conservative 48-hour expiry.
- Reuse only mappings that match the exact owner, project, asset, MIME type and trusted Google URI, with at least two minutes of validity remaining.
- Delete expired provider files best-effort before replacing their mappings.
- If persistence fails after upload, attempt compensating deletion of the remote file.

An ambiguous upload transport failure is surfaced as `GEMINI_FILE_UPLOAD_OUTCOME_UNKNOWN`. The caller must not blindly restart the upload; reconciliation is a separate release requirement.

## Size and storage limits

Google's current Files API documentation lists up to 2 GB per file, 20 GB per project and 48-hour retention. Executive Visuals' existing private Supabase bucket currently has a 250 MB file-size limit. Therefore this gateway defaults to 250 MB, while allowing a reviewed server-side override up to Google's 2 GB ceiling. Increasing the application bucket limit requires a separate migration, infrastructure review and staging test; this branch does not silently change it.

## Supported MIME types

The initial allowlist mirrors the Executive Visuals private asset vault: common JPEG/PNG/WebP/GIF images; MP4/WebM/QuickTime video; supported audio; PDF; plain text; WebVTT; and JSON. A provider's general file support does not imply every MIME type is valid for every Gemini Omni operation. The request planner and model contract remain responsible for operation-specific media roles.

## Persistence

Migration: `supabase/migrations/20261105100000_google_provider_files.sql`

Repository: `server/google-gemini-files-repository.mjs`

Gateway: `server/google-gemini-files-gateway.mjs`

The migration is source-controlled only. It has not been applied to staging or production.

## Remaining integration work

1. Compose the gateway with the existing `createCloudMediaAssetIO` and authenticated `createCloudAssetService`; the loader must return materialized private bytes/path and always clean temporary files.
2. Wire `findProviderFile`, `recordProviderFile` and `deleteProviderFileRecord` to the repository in the cloud worker composition.
3. Add owner/project authorization tests for personal assets, project owners, editors, reviewers, viewers and cross-project access.
4. Add a bounded cleanup worker for expired Google files and stale mappings; deletion failures must be retryable and auditable.
5. Implement the live Gemini Interactions adapter using the existing durable queue, one-shot submission ledger, approval/budget controls, interaction lineage, task reconciliation and private output ingestion.
6. Implement a durable Google interaction record and enforce same-owner/project/model lineage for `previous_interaction_id`.
7. Add a staging-only migration integration test and contract fixture for actual Google Files responses before any live credentials or paid generation are considered.

## Verification

- `server/tests/google-gemini-files-gateway.test.mjs`: mocked resumable upload, cache scope, private asset scope, processing state, API key boundary and failure handling.
- `server/tests/google-gemini-files-repository.test.mjs`: service-role PostgREST headers, exact-scope queries, upsert and deletion.
- Both test files are included in `npm run verify:video-routing`.

## Official references

- [Gemini Files API](https://ai.google.dev/gemini-api/docs/files)
- [Gemini File input methods](https://ai.google.dev/gemini-api/docs/file-input-methods)
- [Gemini Omni Flash](https://ai.google.dev/gemini-api/docs/omni)
- [Gemini Files REST API](https://ai.google.dev/api/files)
