# Cloud runtime capability contract

## Purpose

The unauthenticated `GET /api/health` response exposes a deliberately small, non-secret capability description so clients and operators can distinguish the local development runtime from a cloud-backed runtime without guessing from browser configuration.

## Fields

- `storage`: `local-disk` or `supabase-private`
- `database`: `sqlite` or `supabase-postgres`
- `capabilities.cloudAssets`: cloud asset API is enabled and its startup readiness check succeeded
- `capabilities.cloudProjects`: cloud project API is enabled and its startup readiness check succeeded
- `capabilities.privateSignedDownloads`: private signed-download API is enabled
- `capabilities.cloudModeRequiresSupabaseAuth`: cloud mode is bound to verified Supabase authentication

The server reports cloud capabilities only when `CLOUD_TIMELINE_API_ENABLED=true`, `AUTH_MODE=supabase`, server-side Supabase credentials are present, and the cloud API's startup readiness check succeeds. Startup fails closed if the cloud storage/schema readiness check fails.

## Security boundaries

- This response never contains Supabase URLs, publishable keys, service-role keys, access tokens, refresh tokens, bucket credentials, or signed media URLs.
- A positive capability flag is descriptive, not authorization. Every cloud request still requires a verified account identity and project/asset authorization.
- Clients must not switch project or asset APIs based on a locally supplied browser flag. They must read this server response and use the matching authenticated API contract.
- Signed URLs are short-lived bearer capabilities. Fetch them only after an authenticated asset lookup; do not persist them in local storage, project documents, analytics, or logs.
- Local mode remains the default. The capability flags are all false unless cloud mode is explicitly configured on the server.

## Integration status

The server-side cloud asset API supports project-scoped listing, streamed upload, private signed downloads, and soft deletion. The current browser workspace still uses the local project and asset APIs. A complete browser migration must switch project CRUD, asset listing/upload/download/delete, job routing, and relevant workspace refreshes together; mixing local project IDs with cloud asset IDs is unsafe and unsupported.

No cloud project, database, bucket, policy, migration, or hosted service is provisioned by this contract. Use a dedicated Executive Visuals Supabase project before enabling cloud mode; do not reuse shared or unrelated projects.
