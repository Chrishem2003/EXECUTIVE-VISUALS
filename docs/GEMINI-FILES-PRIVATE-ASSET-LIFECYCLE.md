# Gemini Files private-asset lifecycle

This integration prepares an existing Executive Visuals private asset for the Gemini Files API. It does not submit a model interaction or generation job.

## Runtime gates

All switches default to disabled:

- `GOOGLE_GEMINI_FILES_ENABLED=true` enables the authenticated preparation API.
- `GOOGLE_GEMINI_FILES_CLEANUP_ENABLED=true` enables expired provider-file cleanup in the separate cloud worker.
- `GOOGLE_GEMINI_FILES_RECOVERY_ENABLED=true` enables recovery of uncertain upload attempts in the separate cloud worker.

Required server-side configuration:

- Supabase URL and service-role key for the isolated Executive Visuals database and private asset bucket.
- Supabase Auth session encryption configuration for the API.
- `GEMINI_API_KEY` (or `GOOGLE_GEMINI_API_KEY`) held only by the server.
- The reviewed Executive Visuals schema and private storage policies.

Do not enable these flags on the existing Render web service until the dedicated Executive Visuals backend and worker runtime are verified. Do not put provider credentials in browser/Vite variables.

## API and UI flow

1. The private media library reads `GET /api/integrations/google-gemini/files/status`.
2. An owner/editor chooses **Prepare for Gemini** on an existing private asset and confirms the external temporary copy.
3. The UI posts the asset ID, project ID and media type to `POST /api/integrations/google-gemini/files/prepare`.
4. The server derives the owner from the authenticated session, checks project write access, resolves the private asset and creates a verified temporary Gemini Files copy.
5. The response exposes only the preparation receipt and expiry; it does not expose provider credentials or submit a generation job.

The original Executive Visuals asset remains in private storage. Temporary-file cleanup only deletes the provider-side copy.

## Durable schema

Apply these additive migrations to an isolated staging database, in order:

1. `20261105100000_google_provider_files.sql`
2. `20261105120000_google_provider_file_upload_attempts.sql`
3. `20261105190000_google_provider_file_recovery_leases.sql`

The mappings and upload-attempt ledger are service-role-only, with RLS enabled and forced. Recovery uses expiring leases. Provider-file source lineage distinguishes direct uploads from GCS-backed references.

The CI PostgreSQL job applies the migrations to its disposable schema and checks role privileges, source-lineage columns and recovery-lease constraints. These source-controlled migrations are not permission to apply them to a production database.

## Worker behavior

Run the separate cloud worker only after the isolated schema, storage and server credentials are verified. It supports maintenance-only mode:

- Set `CLOUD_WORKER_ENABLED=true`.
- Leave media, timeline and video worker flags disabled if only maintenance is required.
- Enable one or both Gemini maintenance flags above.
- Supply the server-side Supabase and Gemini credentials.

Cleanup marks expired records before provider deletion and retries incomplete operations. A provider 404 is treated as already deleted. Recovery checks provider metadata and quarantines ambiguous or incomplete evidence instead of guessing whether an upload succeeded.

## Verification

- `npm run verify:batch:10` — gateway, repository, composition, upload, recovery and retention tests.
- The PostgreSQL CI job verifies migration and privilege contracts.
- `npm run verify:server:shard:03` (or the assigned shard in CI) covers cloud-worker process behavior.

No production feature gate should be enabled until the isolated staging database migration, authenticated upload flow, temporary-file cleanup and recovery tests all pass.
