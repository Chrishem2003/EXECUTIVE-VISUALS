# Batch 127 — Production launch gate and operational evidence

## Purpose

This batch introduces a conservative, repeatable launch decision for Executive Visuals. It does not change production configuration or claim that infrastructure has been verified. It prevents a reachable HTTP health endpoint from being mistaken for launch readiness.

## Run the audit

From the repository root:

```bash
EXECUTIVE_VISUALS_BASE_URL=https://your-staging-host.example \
PRIVATE_BUCKET_VERIFIED_AT=2026-11-26T10:00:00Z \
WORKER_HEARTBEAT_VERIFIED_AT=2026-11-26T10:00:00Z \
BACKUP_RESTORE_VERIFIED_AT=2026-11-26T10:00:00Z \
MONITORING_ALERT_VERIFIED_AT=2026-11-26T10:00:00Z \
node scripts/production-launch-audit.mjs
```

The four timestamp variables are operator attestations, not automatic proof. They must be populated only after the corresponding test is completed. Timestamps older than seven days and future timestamps fail. Do not add credentials, signed URLs, object keys or customer data to this audit.

## Required operational evidence

### Private object storage
- Confirm the actual bucket exists and is private at the provider control plane.
- Confirm API and every worker use the same intended provider, region and bucket.
- Upload a test object, verify size and SHA-256, download as its owner, reject a different tenant, and confirm a short-lived download expires.
- Verify restart/redeploy does not remove the object.
- Confirm no public ACL, public bucket policy, or browser-exposed service key exists.
- Keep provider cutovers disabled until a dual-read migration and rollback plan is approved.

### Worker and job reliability
- Confirm the durable Postgres queue migration is applied to the isolated launch database.
- Start the separately deployed worker and verify a recent heartbeat from that actual process.
- Exercise claim, lease renewal, lease expiry recovery, retry/defer, terminal failure, cancellation and duplicate enqueue.
- Kill a worker during a test job and verify recovery does not duplicate paid provider submissions.
- Confirm provider submission-unknown states do not resubmit automatically.
- Verify queue age, retry counts, dead/blocked jobs and worker lag are observable.

### Backup and restore
- Identify the authoritative Postgres database and object-storage bucket.
- Configure database backups/PITR and object versioning or a documented immutable backup strategy.
- Restore into an isolated environment; verify schema, owner/project references, asset metadata, object checksums and a representative project can be opened.
- Record restore start/end, achieved RPO/RTO, operator and result. A backup job reporting success is not a restore test.
- Keep the last known-good backup protected from application credentials.

### Monitoring and incident response
- Alert on API unavailability, worker heartbeat expiry, oldest queued job, repeated retries, database errors, storage failures, backup failures, webhook failures and unreconciled resource usage.
- Route alerts to an actively monitored destination and trigger a test alert.
- Document who pauses paid generation, disables dispatch, investigates, restores and communicates during an incident.
- Verify alerts do not include secrets, signed URLs or customer media.

## Launch blockers surfaced by the audit

- SQLite/local database or non-durable artifact persistence.
- Cloud media disabled, unready, or not explicitly private.
- Supabase auth/session configuration not ready.
- Worker not configured for a separate process with explicit remote gates and output-host allowlist.
- Private download accounting not enabled and verified.
- Billing or webhook secret not configured.
- Missing or stale operator evidence for bucket, worker heartbeat, backup restore or alert delivery.

## Important limitation

The current `/api/health` response reports local database/storage characteristics and configuration summaries. It does not itself prove that a separate worker is alive, that a bucket is private, that a backup can be restored, or that an alert reached an operator. The timestamp attestations make those gaps explicit; they are not a substitute for the underlying test records.

## Safe launch sequence

1. Use a separate staging database and private bucket.
2. Complete all operational tests above and retain evidence.
3. Run this audit against staging and resolve every blocker.
4. Review billing/webhook provider configuration and perform a sandbox payment/refund/replay test.
5. Review the exact production diff, migration plan, rollback and backup restore point.
6. Obtain explicit owner approval before production configuration, migration, merge or deployment.
7. Begin with a controlled cohort, low quotas, strict spend caps and daily reconciliation; increase only after observed unit economics are positive.

This batch does not activate paid generation, payments, storage providers, migrations or production deployment.
