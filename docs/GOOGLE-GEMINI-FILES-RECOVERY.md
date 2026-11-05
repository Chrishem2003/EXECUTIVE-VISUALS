# Google Gemini Files recovery and retention

## Durable source of truth

Executive Visuals private assets remain in the application's private cloud storage. Gemini Files resources are provider-side references and must never replace the durable private asset record.

Use the provider input path that matches the source:

- **GCS registration:** register an existing authorized private GCS object with `POST /v1beta/files:register`. The object bytes are not copied. Google fetches the object when processing the request.
- **Files API upload:** use resumable upload when a durable GCS object is not available or registration is not supported for the workflow.
- **Signed HTTPS URL:** use only for supported request sizes and content types, with short-lived scoped URLs.

Official references:
- https://ai.google.dev/gemini-api/docs/file-input-methods
- https://ai.google.dev/api/files
- https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-new-file-limits/

## Provider retention

- Standard Files API uploads are temporary and automatically deleted after 48 hours.
- GCS URI registration does not copy media bytes. A one-time registration can provide access for up to 30 days; the provider retrieves the object when it is used.
- Treat provider expiration metadata as authoritative when present. Never extend a provider expiry using an application-side guess.
- Keep original media in private application storage and reconcile provider mappings independently.

## GCS registration IAM preflight

The repository includes `server/google-gemini-gcs-iam-verifier.mjs`, a read-only preflight for the Google side of GCS registration.

Required server configuration:
- `GOOGLE_CLOUD_PROJECT_ID`
- `GOOGLE_CLOUD_PROJECT_NUMBER`
- `GEMINI_GCS_ALLOWED_BUCKETS` (comma-separated exact bucket allowlist)

The injected OAuth token provider must obtain a token with `cloud-platform` and `devstorage.read_only` scopes. The preflight checks that the Gemini API is enabled and that the Gemini API service agent (`service-{PROJECT_NUMBER}@gcp-sa-generativelanguage.iam.gserviceaccount.com`) has an unconditional `roles/storage.objectViewer` binding on every allowlisted bucket.

This check is read-only: it does not create the service agent, grant IAM roles, or alter bucket policies. Operators must review and apply any IAM changes through their normal cloud governance process, then rerun the preflight. A missing grant returns `ready: false`; API or IAM lookup errors fail closed.

**Important storage boundary:** the current Executive Visuals private asset adapter stores media in the Supabase Storage bucket `executive-visuals-media`. That bucket is not automatically a Google Cloud Storage bucket and must not be passed to the Gemini GCS registration API as a `gs://` URI. GCS registration is only valid for an actual GCS object whose bucket and object identity have been resolved and authorized server-side. Until a governed GCS-backed asset source is connected, the existing private upload and signed-URL paths remain the supported routes for Supabase-hosted assets.

## Recovery lease protocol

The recovery worker processes only stale attempts in `UPLOADING`, `OUTCOME_UNKNOWN`, or `PROVIDER_CREATED`.

1. List stale candidates with a bounded query.
2. Acquire an atomic 15-minute lease using a conditional update on attempt ID, expected state, and either a null or expired lease.
3. If no row is returned, another worker owns the attempt; do not contact Google.
4. Perform provider metadata reads and validate display name, MIME type, size, SHA-256, state, and expiry.
5. Persist the provider-file mapping, then transition the attempt using the exact lease token.
6. A successful state transition clears the lease. Transient failures release only the matching lease; process crashes are recovered after lease expiry.
7. Missing, ambiguous, incomplete, or mismatched provider evidence remains quarantined. Never start another upload solely because a lookup failed.

The database enforces that `lease_token` and `lease_expires_at` are either both null or both present. The recovery lease index is limited to in-flight states. Browser roles have no access to the upload-attempt ledger; only the trusted service role can claim or release leases.

## Acceptance requirements

- Two simultaneous PostgreSQL claims yield exactly one lease winner.
- A worker without the lease cannot transition an attempt.
- A stale lease can be reclaimed after expiry.
- A transient provider/database failure releases the matching lease or leaves it to expire safely.
- Provider metadata mismatch never creates a provider-file mapping.
- A completed provider mapping and attempt transition are idempotently reconcilable.
- All migration and concurrency tests run against a disposable PostgreSQL database before staging approval.
