# Disposable Neon migration rehearsal

This workflow applies Neon migrations `0001`–`0009` to a fresh PostgreSQL 16 service container created for one GitHub Actions run. It then runs the existing queue, financial settlement, atomic enqueue, approval-bridge and queued-cancellation SQL integration suites.

## Scope and isolation

- The database is an ephemeral CI container, not the connected Neon project, Supabase, Render or production.
- No GitHub staging secrets are referenced.
- No external database URL is accepted by this workflow.
- The migration static audit requires all created tables/functions to be inside `executive_visuals`, rejects references to shared `auth`, `public` and `storage` schemas, requires transactional migrations, and checks pinned `pg_catalog,executive_visuals` search paths for SECURITY DEFINER functions.
- The existing Neon staging branch remains untouched. This rehearsal does not establish that its inherited branch lineage is isolated or that it is safe to apply migrations there.

## Runtime coverage

1. Queue admission idempotency, worker lease, defer and quarantine.
2. Budget and customer-credit reservation, provider-evidence settlement, replay and verified non-billable failure release.
3. Atomic video enqueue, reservation replay, conflict detection and rollback on insufficient credits.
4. Multi-shot approval bridge tables, indexes, foreign keys and required RPC presence.
5. Safe queued cancellation only before a submission record exists, with idempotent credit release.

The CI tests use synthetic UUIDs, test provider identifiers and placeholder evidence. They do not call a video provider, spend money, contact payment gateways or use real customer identities.

## Interpretation

A passing run proves the nine SQL files can be applied in order to a clean PostgreSQL 16 database and that the listed integration tests pass in that disposable environment. It does not prove production cutover, real Supabase Auth integration, tenant JWT/RLS behavior, object storage isolation, backup restoration, worker deployment or payment webhook acceptance.
