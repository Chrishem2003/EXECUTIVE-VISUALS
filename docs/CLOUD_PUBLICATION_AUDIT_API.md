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
