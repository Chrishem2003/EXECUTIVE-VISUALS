# Cloud worker lease fencing and atomic asset publication

**Status:** implementation and disposable PostgreSQL integration coverage are included in this branch. Hosted worker deployment and acceptance are not approved by this document.

## Lease fencing

Every job claim receives a database-generated UUID fencing token. Claim, renew, assert and finish use the v2 worker RPC contract. A worker must carry the token from claim through processing and terminal state writes.

- A worker identity alone is not sufficient to authorize a write.
- A reclaimed job has a new token; an old worker cannot renew or finish it.
- The worker checks its lease before publication and terminal state changes.
- Heartbeat work is drained before terminal writes.
- SIGINT/SIGTERM cancellation is propagated through worker and media process boundaries.
- Worker RPC functions are restricted to the trusted service role; browser roles cannot claim or mutate worker state.

## Atomic publication

A media output is reserved against the owning job, worker identity, lease token, project, owner, idempotency key and output SHA-256.

- Each attempt uploads to a unique immutable object path; overwrites are disabled.
- Finalization locks and rechecks the live job lease before committing asset metadata and the publication ledger together.
- Derivative source relationships must remain within the same owner and project.
- Ambiguous upload/finalization outcomes are sent to a cleanup outbox, not deleted speculatively.
- Cleanup claims are tokenized and restricted to the exact immutable attempt path.

## Cloud media API gate

`CLOUD_MEDIA_JOBS_API_ENABLED` defaults to false. Enabling it requires `CLOUD_TIMELINE_API_ENABLED=true` and `AUTH_MODE=supabase`. The API exposes authorized Asset Library job submission with allowlisted operations, owner/project scope derived on the server, idempotency keys and recent job history.

The API gate does not prove a worker is deployed or healthy. Keep it disabled until the isolated worker is deployed and the complete upload → queue → process → publish → preview → cleanup journey passes.

## Zero-cost validation

The GitHub Actions PostgreSQL service is disposable and isolated to the CI run. It bootstraps a test-only schema, applies the checked-in migrations in order, and runs SQL assertions for role privileges, lease fencing, stale-token rejection, atomic publication, derivative scope and cleanup attempt paths. It does not connect to any hosted Supabase project.

For local validation, use a disposable local PostgreSQL/Supabase stack. Do not link, push migrations to, or reuse the NEMA or other existing Supabase projects.

## Release gates still open

- Deploy separate API and worker services in isolated staging.
- Verify worker liveness, heartbeat, lease expiry/reclaim and graceful shutdown.
- Run end-to-end processing under worker interruption and retry.
- Verify immutable publication, cleanup reconciliation, backups and restore.
- Confirm tenant isolation for owner/editor/reviewer/viewer roles.
- Keep hosted cloud processing disabled until these gates pass.

No production migration, hosted resource provisioning, paid upgrade or production signing is authorized by this branch.
