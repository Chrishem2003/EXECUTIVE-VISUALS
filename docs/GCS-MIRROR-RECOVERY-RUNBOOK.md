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
the dedicated mirror bucket. Prefer a custom role containing only the operations
required by the reviewed code path:

- `storage.objects.create` — create-only resumable upload (the writer uses
  `ifGenerationMatch=0`).
- `storage.objects.get` — read back object metadata for integrity and ownership
  verification.
- `storage.objects.delete` — remove an exact generation after failed
  verification, guarded by `ifGenerationMatch`.

Do not grant bucket IAM administration, bucket creation, project-wide Storage
Admin, or object listing unless a separately reviewed feature requires it.

Google's resumable-upload guidance lists object create and, for overwrite cases,
object delete; its checksum guidance documents sending CRC32C in the final
resumable-upload request's `X-Goog-Hash` header. See:
- https://docs.cloud.google.com/storage/docs/performing-resumable-uploads
- https://docs.cloud.google.com/storage/docs/data-validation
- https://docs.cloud.google.com/storage/docs/access-control/iam-permissions

Google documents `roles/storage.objectUser` as create/read/update/delete object
access; it is broader than the narrow custom role described above. Bucket IAM
and uniform bucket-level access must be reviewed before staging.

## Server-side ADC and Workload Identity Federation bootstrap

The cloud worker now constructs its Google token provider through Google's
official `google-auth-library` and Application Default Credentials (ADC).
The recovery worker no longer depends on a manually injected factory when
started through `npm run start:cloud-worker`.

Choose exactly one production identity path:

- **Google Cloud hosted worker:** attach a dedicated user-managed service
  account to the worker and let ADC obtain short-lived credentials from the
  workload metadata server.
- **External host (for example, a non-Google cloud):** generate a Workload
  Identity Federation external-account credential configuration with the
  Google Cloud CLI and set `GOOGLE_APPLICATION_CREDENTIALS` to its protected
  file path. The external identity must be permitted to impersonate the
  dedicated service account, or be granted direct bucket access.

The bootstrap rejects service-account private-key JSON and user credential
files when `GOOGLE_APPLICATION_CREDENTIALS` is set. Do not paste credential
configuration contents or subject tokens into environment variables, logs,
tickets, or source control. The external-account file contains federation
configuration, not a private service-account key; protect it as deployment
configuration because it describes the external token source.

Required startup settings include:

- `CLOUD_WORKER_ENABLED=true` and at least one approved worker family.
- `GEMINI_GCS_MIRROR_RECOVERY_ENABLED=true` only for the isolated staging
  worker after the identity and bucket policy are approved.
- `GOOGLE_CLOUD_PROJECT_ID`, `GEMINI_GCS_ALLOWED_BUCKETS`, and
  `GEMINI_GCS_MIRROR_BUCKET`.
- `GEMINI_GCS_SESSION_ENCRYPTION_KEY`: base64 encoding of exactly 32 random
  bytes. Generate and store it in the host's secret manager; never reuse the
  Supabase service-role key or Google OAuth token.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the worker only.

At startup the worker obtains a short-lived ADC token before registering the
GCS recovery maintenance task. Token acquisition failure aborts startup. The
token provider is cached by scope set and does not log or persist access
tokens. The GCS mirror remains opt-in; this bootstrap does not enable the
feature flag or change cloud IAM.

Official references:
- https://docs.cloud.google.com/storage/docs/authentication
- https://docs.cloud.google.com/docs/authentication/application-default-credentials
- https://docs.cloud.google.com/iam/docs/workload-identity-federation
- https://github.com/googleapis/google-auth-library-nodejs

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
