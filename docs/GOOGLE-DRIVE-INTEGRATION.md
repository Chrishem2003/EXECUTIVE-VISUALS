# Google Drive private workspace integration

This integration is opt-in and disabled by default. It supports importing files explicitly selected through Google Picker into the existing private Executive Visuals asset library and exporting private assets back to the connected user's Drive.

## Security and data boundaries

- Google OAuth uses the restricted `drive.file` scope plus OpenID identity verification.
- OAuth state is one-time, short-lived, hashed at rest, and its PKCE verifier/nonce payload is encrypted.
- Google refresh tokens are encrypted server-side with AES-GCM before persistence.
- The connection and OAuth-state tables are service-role-only, protected by RLS, and do not grant access to browser roles.
- Access tokens are returned only to the authenticated user's short-lived Picker-token request.
- Imports are size- and MIME-validated and written to the existing private asset service.
- Exports read only an asset owned by the authenticated user and verify its byte count and SHA-256 before upload.
- The browser never receives a service-role key or refresh token.
- The integration does not enable remote AI generation, billing, or any other provider execution.

## Prerequisites

1. The application must use verified Supabase authentication.
2. The existing Supabase project must have the reviewed Executive Visuals private-media schema and the `executive-visuals-media` private bucket configured.
3. Apply the two migration files in this directory through the normal reviewed migration process:
   - `20261105150000_google_drive_connections.sql`
   - `20261105153000_google_drive_oauth_states.sql`
   - `20261105170000_google_drive_export_attempts.sql`
   - `20261105180000_google_drive_export_lease_integrity.sql`
4. In Google Cloud, enable Google Drive API and Google Picker API, configure the OAuth consent screen, and create an OAuth web client.
5. Add this exact authorized redirect URI to the Google OAuth client:
   `https://executive-visuals.onrender.com/api/integrations/google-drive/callback`
   For local development, use the exact local callback URI configured by the local environment.

## Server environment

Configure these only in the server environment; never in browser settings or source control:

- `GOOGLE_DRIVE_OAUTH_ENABLED=true`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` — a high-entropy secret suitable for AES-256-GCM key derivation; keep it stable for existing encrypted tokens.
- `GOOGLE_DRIVE_EXPORT_SESSION_ENCRYPTION_KEY` — a separate high-entropy key (at least 32 characters) used only to encrypt resumable upload session URIs in the durable export-attempt ledger. It must differ from the OAuth token key and remain stable while attempts are recoverable.
- `GOOGLE_PICKER_API_KEY`
- `GOOGLE_CLOUD_PROJECT_NUMBER` — numeric Google Cloud project number.
- Existing server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Existing verified-auth `AUTH_MODE=supabase` and `SUPABASE_SESSION_ENCRYPTION_KEY`.

Do not enable the feature flag until the migrations, private bucket, OAuth client, redirect URI and secrets are configured and verified. A missing or invalid configuration must leave the integration unavailable rather than fall back to public storage.

## Verification

The Google Drive OAuth coordinator, encrypted connection/state stores, and private-file bridge have dedicated Node tests under `server/tests/google-drive-*.test.mjs`. The normal server verification suite includes these tests. After applying migrations in an isolated staging environment, verify connect, callback, status, picker-token, import, export, disconnect, owner isolation, token revocation and checksum mismatch handling before enabling the feature in production.
## Resumable export recovery

Exports use a durable, owner-scoped attempt ledger when Drive is enabled. Each attempt reserves a Google Drive file ID before upload, binds it to the private asset SHA-256, and uses an expiring lease so concurrent workers cannot duplicate the same export. Resumable session URIs are AES-GCM encrypted at rest with the separate `GOOGLE_DRIVE_EXPORT_SESSION_ENCRYPTION_KEY`; they are never returned to the browser. Interrupted uploads query the provider session offset and resume from the confirmed byte range. Ambiguous outcomes and expired sessions are quarantined for provider reconciliation against the reserved file ID and MD5 checksum rather than blindly creating duplicate files. The ledger is service-role-only under forced RLS.

The migration and PostgreSQL contract are exercised by `.github/workflows/google-drive-export-recovery.yml`. Applying the migrations to a production Supabase project remains an explicit operator action; this implementation does not apply migrations or activate OAuth credentials by itself.
