# Cloud publication cleanup audit API

The read-only audit API is an opt-in server feature. It is not enabled by default.

## Enablement

Set the following variables on the API service only:

- \`AUTH_MODE=supabase\`
- \`CLOUD_PUBLICATION_AUDIT_API_ENABLED=true\`
- \`SUPABASE_URL\`
- \`SUPABASE_PUBLISHABLE_KEY\`
- \`SUPABASE_SERVICE_ROLE_KEY\`
- \`PUBLICATION_AUDIT_ADMIN_EMAILS=admin1@example.com,admin2@example.com\`

The service-role key must never be sent to a browser, mobile app, worker log, or client bundle. Apply the migration \`20261107030000_publication_cleanup_audit_events.sql\` through the normal reviewed database migration process before enabling the API. Startup performs a read-only readiness check and fails closed if the ledger is unavailable.

## Endpoint

\`GET /api/cloud/publication-audit\`

Requires a verified Supabase session and an email present in \`PUBLICATION_AUDIT_ADMIN_EMAILS\`. Project-scoped queries additionally require the caller to have read access to the project. Queries without \`projectId\` are restricted to the caller's personal (project-less) events.

Supported query parameters:

- \`projectId\`: UUID, optional.
- \`eventType\`: one of the four publication cleanup event types.
- \`jobId\`, \`runId\`, \`actorId\`: UUID filters.
- \`from\`, \`to\`: ISO timestamps.
- \`limit\`: 1–100, default 50.
- \`cursor\`: opaque keyset-pagination cursor returned by the previous response.

Responses are read-only and include \`events\`, \`nextCursor\`, \`hasMore\`, and \`limit\`. The API does not expose arbitrary table selection, raw PostgREST filters, write operations, or service credentials.

## Safety boundaries

- Disabled unless explicitly opted in.
- Requires Supabase authentication; local auth mode is rejected at startup.
- Requires an explicit administrator email allowlist.
- Project authorization is checked before any project audit query.
- Personal queries are constrained to the authenticated owner and null project.
- Query fields, event types, identifiers, date ranges, and page sizes are validated.
- Uses stable keyset pagination and a server-side service-role credential.
- Rate limited at the HTTP boundary.
- No migration is automatically applied and no cleanup worker is activated by this API.


## Opt-in cleanup worker

The cleanup worker is part of the separate cloud worker process. It is disabled unless \`CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED=true\`.

Minimum server-only configuration:

- \`CLOUD_WORKER_ENABLED=true\`
- \`CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED=true\`
- \`SUPABASE_URL\`
- \`SUPABASE_SERVICE_ROLE_KEY\`

The worker defaults to dry-run. It scans at most 10 stale publication records per cycle and 100 objects per publication; the polling interval defaults to five minutes. It checks that the owning job is terminal and has no live lease, verifies object references, persists an eligible-candidate audit event, obtains the database cleanup claim, removes only the exact attempt object, and completes the tombstone.

### Destructive mode

Do not enable destructive mode until the migrations are reviewed and applied to an isolated staging database and private storage bucket. Destructive mode requires both flags:

- \`CLOUD_PUBLICATION_CLEANUP_DELETE_ENABLED=true\`
- \`CLOUD_PUBLICATION_CLEANUP_CONFIRM_DELETE=true\`

The cleanup RPC independently validates job state, owner/project/publication identity, minimum age, object path and existing asset references. The worker uses the append-only audit sink with up to three immediate attempts and stops before deletion if an eligible-candidate event is not durably acknowledged.

Optional tuning:

- \`CLOUD_PUBLICATION_CLEANUP_OLDER_THAN_DAYS\`: 1–30, default 1.
- \`CLOUD_PUBLICATION_CLEANUP_PUBLICATION_LIMIT\`: 1–50, default 10.
- \`CLOUD_PUBLICATION_CLEANUP_OBJECT_LIMIT\`: 1–100, default 100.
- \`CLOUD_PUBLICATION_CLEANUP_POLL_MS\`: 10,000–3,600,000, default 300,000.

No database migration is applied automatically by worker startup.
