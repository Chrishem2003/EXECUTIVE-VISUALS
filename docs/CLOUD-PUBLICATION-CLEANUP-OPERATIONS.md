# Publication cleanup and audit operations

## Purpose

The publication cleanup worker reclaims orphaned immutable upload-attempt objects left behind by interrupted or superseded media jobs. It is separate from the existing asset-storage cleanup outbox and never changes published asset records.

## Safety defaults

- Worker is disabled unless `CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED=true`.
- Dry-run is the default. `CLOUD_PUBLICATION_CLEANUP_DELETE_ENABLED` must be explicitly enabled to leave dry-run mode.
- Actual deletion additionally requires `CLOUD_PUBLICATION_CLEANUP_CONFIRM_DELETE=true`.
- The worker only scans bounded, owner/project-scoped asset prefixes and stale publication rows.
- A database-issued cleanup claim fences the exact object path against late publication finalization.
- The worker checks current asset references and active job leases before deleting anything.
- Audit events are written to an append-only table before cleanup claims are finalized.
- If a claim or storage deletion is interrupted, the still-claimed path is reconciled on a later cycle.

## Required database objects

Apply the mainline migrations in order, including:

- `20261108020000_asset_publication_cleanup_claims.sql`
- `20261108030000_storage_cleanup_attempt_paths.sql`
- `20261114130000_publication_cleanup_audit_events.sql`

The worker performs a startup readiness check against the assets, jobs, publication ledger, cleanup-claim ledger and audit ledger. It fails closed if any table is unavailable.

## Operator configuration

Start with the defaults in `.env.example`. Recommended initial configuration:

```ini
CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED=true
CLOUD_PUBLICATION_CLEANUP_DELETE_ENABLED=false
CLOUD_PUBLICATION_CLEANUP_CONFIRM_DELETE=false
CLOUD_PUBLICATION_CLEANUP_OLDER_THAN_DAYS=7
CLOUD_PUBLICATION_CLEANUP_PUBLICATION_LIMIT=10
CLOUD_PUBLICATION_CLEANUP_OBJECT_LIMIT=100
CLOUD_PUBLICATION_CLEANUP_POLL_MS=300000
CLOUD_PUBLICATION_AUDIT_API_ENABLED=true
```

Run in dry-run mode first and inspect the `publication_cleanup_cycle` logs and audit records. Do not enable deletion until the isolated database, storage bucket, reference checks, claim fencing and audit trail have been verified. Deletion requires both independent flags; never enable either flag merely to clear a CI check.

The audit API is available at `GET /api/cloud/publication-audit` when enabled and requires Supabase-authenticated access. Project records are owner-scoped; global audit access requires an explicitly configured administrator email allowlist.

## Not enabled by this change

This implementation adds the worker and its controls but does not turn it on in Render, change production environment variables, activate Cloudflare R2, or run a production cleanup. Those remain separate operator-approved actions.
