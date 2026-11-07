# Google Drive integration — secure private media bridge

## Scope

This branch adds a user-controlled Google Drive connection to the existing cloud project asset library:

- Connect/disconnect a Google account through OAuth 2.0 authorization code + PKCE.
- Request only `drive.file`, `openid` and verified email scopes.
- Select existing files or upload a file through Google Picker, then import the selected binary into the Executive Visuals private asset bucket.
- Export an existing owner/project-authorized private asset to Drive using a resumable upload, optionally into a user-selected folder.
- Preserve the private Executive Visuals asset as the canonical source. Drive files are external copies, not the platform's source of truth.

Google-native Docs/Sheets/Slides conversion is not implied; the bridge handles the binary MIME types explicitly allowlisted in its adapter.

## Required staging configuration

All values are server-side deployment secrets/settings. Never add them to browser code or source control.

- `AUTH_MODE=supabase`
- `CLOUD_TIMELINE_API_ENABLED=true` — Drive uses the same private cloud projects/assets and therefore requires that cloud workspace to pass its own readiness check.
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
- `GOOGLE_DRIVE_OAUTH_ENABLED=true` only after the isolated staging schema, private bucket and Google Cloud OAuth client are ready.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
- `GOOGLE_OAUTH_REDIRECT_URI`, exactly matching the OAuth client callback URI: `https://<staging-host>/api/integrations/google-drive/callback`.
- `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`: independent random secret of at least 32 characters for refresh-token and OAuth-state encryption.
- `GOOGLE_DRIVE_EXPORT_SESSION_ENCRYPTION_KEY`: a different independent random secret of at least 32 characters for resumable upload session URLs. These URLs are bearer credentials and must remain encrypted and server-only.
- `GOOGLE_PICKER_API_KEY`: restrict to the staging web origin and Google Picker API.
- `GOOGLE_CLOUD_PROJECT_NUMBER`: numeric Google Cloud project number used by Picker.

In Google Cloud, enable Google Drive API and Google Picker API, configure the OAuth consent screen, and register the exact staging origin and callback URI. Picker API key restrictions should include the staging origin and the Picker API only.

## Data and security boundaries

Four additive migrations are included:

1. `20261105150000_google_drive_connections.sql` — per-user Google subject/email, granted scopes and AES-GCM encrypted refresh-token envelope.
2. `20261105153000_google_drive_oauth_states.sql` — hashed one-time OAuth state with encrypted PKCE verifier/nonce and short expiry.
3. `20261105170000_google_drive_export_attempts.sql` — durable export attempt ledger with encrypted resumable-session URI, immutable asset receipt and recovery state.
4. `20261105180000_google_drive_export_lease_integrity.sql` — paired lease-field constraint and efficient expired-lease lookup.

The tables force RLS and revoke access from public, anon and authenticated roles. Only the trusted service role can access them. Apply these migrations only to an isolated staging Supabase project after the existing Executive Visuals core/cloud schema is installed and reviewed. They have not been applied to staging or production by this branch.

OAuth state is one-time and owner-bound. The callback trusts the owner from the consumed server-side state record, not a query parameter. Refresh tokens and upload session URLs are encrypted with separate keys. Browser APIs never return either secret. Private asset export re-authorizes owner/project scope and verifies the source SHA-256 before upload. Ambiguous resumable upload outcomes are reconciled from the durable attempt record rather than blindly repeated.

## API routes

- `POST /api/integrations/google-drive/connect`
- `GET /api/integrations/google-drive/callback`
- `GET /api/integrations/google-drive/status`
- `POST /api/integrations/google-drive/picker-token`
- `POST /api/integrations/google-drive/disconnect`
- `POST /api/integrations/google-drive/import`
- `POST /api/integrations/google-drive/export`

The feature is disabled by default. When disabled, the routes fail closed. The Picker access token is short-lived and returned only to an authenticated owner after the Google connection has been verified.

## Verification still required

- Run exact-head Quality/typecheck/build and disposable PostgreSQL migration checks.
- On isolated staging, verify OAuth connect/callback/state replay, account disconnect/revocation, Picker file import, folder selection, resumable export, interrupted-upload recovery and checksum mismatch handling.
- Verify owner/editor/viewer and cross-project authorization with separate test accounts.
- Confirm bucket privacy, object retention, Google OAuth consent status and key restrictions.
- Complete a backup/restore rehearsal for the cloud asset database and private bucket before any customer use.

No production environment, Render service, live Google OAuth account, Drive file, shared database, paid provider, or deployment is modified by this branch.
