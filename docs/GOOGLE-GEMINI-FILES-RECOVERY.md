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

## GCS source resolver and caller access verification

The registrar must never accept a caller-supplied `gs://` URI. The new `server/google-gemini-gcs-asset-resolver.mjs` accepts only a server-owned source record returned by an injected registry loader scoped to the authenticated asset ID, owner ID and project ID.

Before returning a GCS URI, the resolver performs an authenticated metadata GET for the exact bucket/object using the application's Google Cloud OAuth identity. This verifies the caller identity can read that exact object and checks:
- bucket and object name against the trusted source record;
- immutable GCS object generation and metageneration (detecting object metadata changes);
- byte size and MIME type;
- custom metadata binding the object to the Executive Visuals asset, owner, project and SHA-256 digest;
- the server-side bucket allowlist and active source state.

The resolver does not download media bytes. A 403 from the metadata lookup fails closed as `GEMINI_GCS_CALLER_ACCESS_DENIED`. The separate IAM preflight checks the Gemini service agent's bucket-level access. Both checks are required; one does not replace the other.

`server/google-gemini-gcs-composition.mjs` composes this resolver with the existing Gemini GCS registrar and durable provider-file repository. Its dependencies (`loadSource`, `getAccessToken`, and `authorizePrivateAsset`) must be supplied by trusted server code. It is intentionally not enabled in the main server runtime until a GCS mirror/source registry and a production-grade Google Cloud OAuth identity provider are available.

The current Supabase Storage assets are not GCS objects. The source registry callback must resolve only assets that have an independently created and verified GCS mirror; it must not synthesize a GCS URI from a Supabase bucket or object path.

## Governed GCS mirror source registry

The additive migration `20261105200000_google_gcs_asset_sources.sql` introduces `executive_visuals.google_gcs_asset_sources`. It stores the exact GCS bucket/object, immutable object generation and metageneration, byte size, MIME type, SHA-256, and the linked Executive Visuals asset/owner/project scope.

Security and lifecycle rules:
- RLS is enabled and forced; public, anon and authenticated roles receive no table privileges. Only the trusted service role can read or write source records.
- A database trigger verifies the referenced asset exists, is not deleted, and has the same owner, project, media type, byte size and SHA-256 at insert time.
- Only one ACTIVE GCS mirror can exist for an asset.
- Source identity fields are immutable. The only supported update is ACTIVE to REVOKED; source records are not repointed to a different object.
- The server adapter `server/google-gemini-gcs-source-repository.mjs` scopes lookups by asset, owner, project and ACTIVE state. It refuses ambiguous mappings and provides an exact-scope revocation operation.
- The GCS composition uses this repository by default when no trusted source loader is injected.

**Not yet complete:** the controlled GCS mirror writer and its metadata verification/compensation lifecycle. Do not create source rows manually or treat an unverified upload receipt as proof. The next implementation step must upload the private asset to an allowlisted GCS bucket, write the ownership/checksum custom metadata, read back the exact object metadata, and only then call `recordVerifiedSource`. Until that writer exists and passes staging acceptance, existing Supabase private storage remains the canonical asset store and GCS registration is not enabled for user traffic.

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
