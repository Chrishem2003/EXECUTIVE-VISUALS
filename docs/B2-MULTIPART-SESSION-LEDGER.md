# B2 multipart upload session ledger

## Purpose

The B2 S3-compatible adapter can upload large media as multipart objects. This migration and repository add durable, owner-scoped records for upload sessions and per-part receipts so a later API integration can recover provider upload IDs and reconcile completed parts after a process restart.

## State model

- `active`: upload accepts part receipts until its expiry.
- `completing`: all expected parts are recorded and one caller has claimed completion using a compare-and-set update.
- `completed`: the object completion step was acknowledged.
- `aborted`: an explicit cancellation was recorded.
- `expired`: the session expired before completion.
- `failed`: reserved for a terminal provider/verification failure.

Each session is bound to owner, optional project, asset ID, idempotency key, exact private bucket/object path, provider upload ID, source size and SHA-256, part size/count, and expiry. The parts table stores the ETag, SHA-256, byte size, and timestamp for each part. Repeating the same receipt is idempotent; reusing a part number with different bytes is rejected.

## Security

Both tables have RLS enabled and deny access to public, anon, and authenticated roles. Only the server-side `service_role` can access them. The store requires owner and session IDs on reads and mutations; application routes must additionally call the existing project/asset authorization boundary before invoking it. Never return `upload_id`, object paths, raw database rows, or service credentials to browser clients.

## Important integration boundary

This is the durable persistence layer, not yet a complete browser-facing resumable upload workflow. The next integration must connect the store to authenticated begin/part/status/complete/abort API routes and to explicit B2 list-parts reconciliation. It must also register the completed object as an asset only after the source checksum and provider completion are verified. Do not advertise restart-safe resumability in the UI until those routes and end-to-end tests are merged.

## Verification

`npm run verify:cloud-queue` includes:
- `server/tests/b2-multipart-upload-store.test.mjs`
- `server/tests/b2-multipart-upload-migration.test.mjs`
- Existing B2 adapter and cloud queue regression suites.

The migration is additive. It is not applied automatically to staging or production by this code change.
