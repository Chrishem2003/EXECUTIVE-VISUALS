# Batch 124 — Initialize storage-retention checkpoints at asset publication

## Objective
Connect verified asset creation to the Batch 123 retention ledger without charging at upload time or depending on each upload transport to remember a separate checkpoint call.

## Implementation
- An `AFTER INSERT` trigger on the canonical cloud `assets` table creates a checkpoint for every newly published, non-deleted asset.
- The cursor starts at the persisted `created_at` value and preserves the exact owner/project attribution.
- The insert is idempotent and does not overwrite an existing cursor.
- Existing active assets are backfilled with a baseline cursor; this is measurement readiness only, not a historical charge.
- Already-deleted assets do not open a new retention interval.
- The trigger is security-definer with a fixed search path; browser and service roles cannot call it directly.
- The existing multipart completion path and normal verified cloud asset registration both publish through the same `assets` table, so they receive the same database-enforced initialization.

## Accounting boundaries
- Upload bytes are not storage GB-days and do not create a storage cost event.
- A checkpoint is not a price, invoice, cost, or customer charge.
- Historical storage costs are not fabricated for the backfilled period.
- The retention scheduler, deletion closure, local SQLite lifecycle, and completed-download capture remain separate follow-up work.

## Verification
- Disposable PostgreSQL integration verifies automatic checkpoint creation, exact cursor/owner/project attribution, no synthetic cost event, and no new interval for already-deleted assets.
- The Batch 123 PostgreSQL suite and measurement/recorder unit tests remain part of the same CI workflow.
- No production migration or deployment is performed by this PR.
