# B2 multipart upload session ledger

## Purpose

The B2 S3-compatible adapter can upload large media as multipart objects. The additive migration, durable repository, and authenticated API now provide owner-scoped upload sessions, per-part receipts, direct-to-B2 signed part URLs, restart recovery, provider-part reconciliation, independent object verification, and Asset Library publication.

## State model

- `active`: upload accepts part receipts until its expiry.
- `completing`: all expected parts are recorded and one caller has claimed completion using a compare-and-set update.
- `completed`: the object was independently verified, its Asset Library record was registered, and the session state was committed.
- `aborted`: an explicit cancellation was recorded.
- `expired`: the session expired before completion.
- `failed`: reserved for a terminal provider/verification failure.

Each session is bound to owner, optional project, asset ID, idempotency key, exact private bucket/object path, provider upload ID, source size and SHA-256, part size/count, and expiry. The parts table stores the ETag, SHA-256, byte size, and timestamp for each part. Repeating the same receipt is idempotent; reusing a part number with different bytes is rejected.

## Security

Both tables have RLS enabled and deny access to public, anon, and authenticated roles. Only server-side Supabase secret/service-role credentials can access them. The authenticated API verifies the signed-in owner and project membership before each operation. Raw provider `upload_id` values and object paths are omitted from session metadata. A short-lived presigned part URL necessarily embeds the scoped object key and multipart upload ID as part of its signed request; treat that URL as a temporary bearer capability, never log it, and never persist it. Service credentials never leave the server.

## Important integration boundary

The browser-facing API is opt-in and is exposed only when `B2_MULTIPART_UPLOAD_API_ENABLED=true`, `CLOUD_MEDIA_STORAGE_PROVIDER=b2`, and verified Supabase authentication are configured. Routes: `POST /api/cloud/uploads`, `POST /api/cloud/uploads/:id/parts/:part/url`, `POST /api/cloud/uploads/:id/parts/:part/receipt`, `GET /api/cloud/uploads/:id`, `POST /api/cloud/uploads/:id/complete`, and `POST /api/cloud/uploads/:id/abort`. Completion reconciles the provider's part list against durable receipts, completes the multipart object, independently reads and verifies the complete object SHA-256/size/content type, registers the asset, and only then marks the session completed. Completion claims have a five-minute lease so a later worker/request can recover after a process interruption.

Before enabling the flag, apply this additive migration to the isolated Supabase project. On startup, the API probes both ledger tables and fails closed if either table is missing. Also configure the private B2 bucket's S3-compatible CORS rule for the exact deployed web origin: allow `PUT`, allow the required request headers (or `*`), and expose `ETag` so the browser can report the part receipt. Do not use wildcard origins for a production private-media bucket. Test CORS, upload, refresh/resume, completion, abort and foreign-project denial in staging. The feature flag is intentionally false in `.env.example`; this code change does not apply migrations or alter hosting configuration.

## Verification

`npm run verify:cloud-queue` includes:
- `server/tests/b2-multipart-upload-store.test.mjs`
- `server/tests/b2-multipart-upload-api.test.mjs`
- `server/tests/b2-multipart-upload-migration.test.mjs`
- Existing B2 adapter and cloud queue regression suites.

The migration is additive. It is not applied automatically to staging or production by this code change.
