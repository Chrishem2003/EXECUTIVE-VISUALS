# GCS mirror recovery — operator integration contract

Status: implementation and disposable CI complete; real-cloud staging is not approved.

## Architecture boundary

The cloud worker supervisor accepts an explicitly injected
`createGoogleGeminiGcsMirrorService` factory. The factory can be constructed with
`createGoogleGeminiGcsMirrorServiceFactory` from
`server/google-gemini-gcs-mirror-service-factory.mjs`.

The factory deliberately does **not** manufacture Google credentials. The
hosting process must inject a server-side `getAccessToken` implementation
backed by an approved workload identity. Do not reuse per-user Google Drive
OAuth tokens: those represent user consent and are not a workload identity for
the GCS bucket.

The repository's standalone `npm run start:cloud-worker` entry point calls
`startCloudWorkerProcess()` without injected dependencies. Therefore the GCS
recovery feature flag must remain disabled for that entry point until a reviewed
server bootstrap supplies the factory. Enabling the flag without the factory
must fail startup closed; this is intentional.

## Required server-only settings

- `GOOGLE_CLOUD_PROJECT_ID`
- `GEMINI_GCS_ALLOWED_BUCKETS`
- `GEMINI_GCS_MIRROR_BUCKET`
- `GEMINI_GCS_SESSION_ENCRYPTION_KEY` — base64-encoded 32-byte key used for
  AES-256-GCM encryption of resumable session URIs
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — worker process only
- `GEMINI_GCS_MIRROR_RECOVERY_ENABLED=false` until staging approval
- `GEMINI_GCS_MIRROR_RECOVERY_INTERVAL_MS=300000`

Never place service-role credentials, Google tokens, private keys, or resumable
session URIs in browser configuration, client bundles, logs, or user-visible
responses.

## Google Cloud identity

Use a dedicated service identity for this application and grant access only on
the dedicated mirror bucket. Prefer a custom role containing the operations
actually required by the reviewed code path. The current writer/recovery path
needs object create, metadata read, and exact-generation delete for failed
verification cleanup. Do not grant project-wide Storage Admin.

Google documents `roles/storage.objectUser` as create/read/update/delete object
access; it is broader than the narrowest custom role. Bucket IAM and uniform
bucket-level access must be reviewed before staging.

## Staging acceptance gates

1. Review workload identity configuration and token audience/scopes.
2. Verify the identity can create, read metadata, and delete only within the
   dedicated bucket; verify it cannot set bucket IAM or create buckets.
3. Run one synthetic private test asset through create-only resumable upload.
4. Confirm the final upload request carries `X-Goog-Hash: crc32c=...`.
5. Confirm GCS server CRC32C and generation match the immutable attempt receipt.
6. Interrupt an upload mid-stream; confirm recovery recomputes source SHA-256 and
   CRC32C before resuming the remaining byte range.
7. Tamper with the source or checksum receipt; confirm quarantine and no source
   registry registration.
8. Confirm session URIs remain encrypted at rest and never appear in logs.
9. Confirm private asset ownership remains canonical in Supabase.
10. Confirm shutdown stops the maintenance worker and lease expiry permits safe
    recovery by a replacement worker.

## Current verification

The code is covered by the provider regression suite and disposable PostgreSQL
workflow. These checks do not substitute for live Google OAuth, IAM, bucket,
network-failure, or production-like staging acceptance.

Do not enable the flag, change IAM, apply the migration to production, or deploy
until all staging gates are reviewed and explicitly approved.
