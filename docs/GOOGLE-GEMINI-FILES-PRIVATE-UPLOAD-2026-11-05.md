# Google Gemini Files API — private upload gateway

Research and implementation snapshot: 2026-11-05.

## Status

- PR #48 supplies the Gemini Omni Flash request planner and response normalizer.
- This branch adds the server-side resumable Files API upload gateway and a service-role-only Postgres mapping repository.
- All remote execution remains disabled. Tests use mocked fetch only; no Google API key or live upload is used.
- The gateway is composed into authenticated `GET /api/integrations/google-gemini/files/status` and `POST /api/integrations/google-gemini/files/prepare` routes. The prepare route accepts only a private asset ID, optional project ID and MIME type; it returns a bounded receipt without the Google URI. A separate opt-in worker maintenance path schedules expired-file cleanup. The provider generation worker remains independently gated.
- PR #82 adds HTTP-level coverage for anonymous denial, authenticated disabled status, disabled prepare behavior and credential-safe error responses. The exact-head build and disposable PostgreSQL integration checks passed on commit `d697c965a3f404a7f2a6f333e263fd76d28670c1`; Supabase Preview was skipped because the PR branch is not linked to a Supabase preview branch.

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
- Reuse only ACTIVE mappings that match the exact authenticated owner, project, asset, MIME type, SHA-256, size and trusted Google URI, with at least two minutes of validity remaining.
- Re-authorize the private asset before reusing a cached Google URI; project collaborators receive separate user-scoped mappings.
- Delete expired provider files best-effort before replacing their mappings.
- If persistence fails after upload, attempt compensating deletion of the remote file.

An ambiguous upload transport failure is surfaced as `GEMINI_FILE_UPLOAD_OUTCOME_UNKNOWN`. The caller must not blindly restart the upload; reconciliation is a separate release requirement.

## Size and storage limits

Google's current Files API documentation lists up to 2 GB per file, 20 GB per project and 48-hour retention. Executive Visuals' existing private Supabase bucket currently has a 250 MB file-size limit. Therefore this gateway defaults to 250 MB, while allowing a reviewed server-side override up to Google's 2 GB ceiling. Increasing the application bucket limit requires a separate migration, infrastructure review and staging test; this branch does not silently change it.

## Supported MIME types

The initial allowlist mirrors the Executive Visuals private asset vault: common JPEG/PNG/WebP/GIF images; MP4/WebM/QuickTime video; supported audio; PDF; plain text; WebVTT; and JSON. A provider's general file support does not imply every MIME type is valid for every Gemini Omni operation. The request planner and model contract remain responsible for operation-specific media roles.

## Composition

`server/google-gemini-files-composition.mjs` composes the existing private asset service and materialization IO with the gateway and Postgres mapping repository. It performs no network calls during construction. On resolution, it first obtains an owner/project-authorized asset receipt; the actual upload path materializes the private object, verifies the checksum and always cleans the temporary directory.

## Persistence

Migration: `supabase/migrations/20261105100000_google_provider_files.sql`

Repository: `server/google-gemini-files-repository.mjs`

Gateway: `server/google-gemini-files-gateway.mjs`

The migration is source-controlled only. It has not been applied to staging or production.

## Remaining integration and release work

1. Complete isolated staging verification with test media: owner/editor/viewer/cross-project authorization, Drive Picker import/export, private asset integrity, upload and exact-scope cache reuse.
2. Verify the opt-in cleanup schedule against staging provider files, including retry after provider/network failure and idempotent handling of provider 404 responses.
3. Reconcile ambiguous resumable-upload outcomes before automatic retry; never assume a timed-out upload did not create a provider file.
4. Implement and verify the live Gemini Interactions adapter using the existing durable queue, one-shot submission ledger, approval/budget controls, interaction lineage, task reconciliation and private output ingestion.
5. Enforce same-owner/project/model lineage for `previous_interaction_id` and prove that generated outputs remain private and attributable.
6. Confirm all checks on the final exact PR head. Supabase Preview must be explicitly enabled or an equivalent isolated staging database must be used before migration or live provider credentials are considered.

## Verification

- `server/tests/google-gemini-files-gateway.test.mjs`: mocked resumable upload, cache scope, private asset scope, processing state, API key boundary and failure handling.
- `server/tests/google-gemini-files-repository.test.mjs`: service-role PostgREST headers, exact-scope queries, upsert and deletion.
- `server/tests/google-gemini-files-composition.test.mjs`: no-network construction and composition wiring.
- `server/tests/google-gemini-files-upload-service.test.mjs`: owner/editor authorization, viewer denial, invalid requests, safe receipts and audit behavior.
- `server/tests/google-gemini-files-retention-worker.test.mjs`: expiry tombstones, provider deletion, 404 reconciliation and retry behavior.
- `server/tests/api.test.mjs`: authenticated HTTP route gates and fail-closed disabled behavior.
- All three test files are included in `npm run verify:video-routing`.
- The disposable PostgreSQL workflow applies the new migration and verifies RLS, service-role privileges, browser-role denial and the private-asset foreign key.

## Official references

- [Gemini Files API](https://ai.google.dev/gemini-api/docs/files)
- [Gemini File input methods](https://ai.google.dev/gemini-api/docs/file-input-methods)
- [Gemini Omni Flash](https://ai.google.dev/gemini-api/docs/omni)
- [Gemini Files REST API](https://ai.google.dev/api/files)
