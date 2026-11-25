# Batch 123 — Asset resource event ledger and retention checkpoints

## Objective
Turn the Batch 121 measurement primitives into a durable, asset-scoped evidence contract. This batch intentionally does not pretend an asset is a generation job.

## Included
- Immutable `asset_resource_measurement_events` for storage-retention and completed-egress measurements.
- Per-asset `asset_storage_retention_checkpoints` with a monotonic cursor.
- A single security-definer RPC that inserts the immutable event and advances the storage cursor in one PostgreSQL transaction.
- Strict owner/project/asset matching against the persisted asset row.
- Exact byte-based quantity verification in PostgreSQL (decimal GB and GB-days).
- Idempotency replay returns the original event; reuse of an identity with changed attribution or measurement is rejected.
- Canonical UTC interval identities in the measurement builder.
- Server-side RPC adapter with no generation-job attribution.

## Atomicity and retry behavior
For a storage interval, the RPC locks the asset checkpoint, requires the submitted interval start to equal the persisted cursor, validates the measured quantity against the asset byte size and elapsed seconds, inserts the immutable event, and advances the cursor before the transaction commits. If any step fails, PostgreSQL rolls back both event and cursor. A retry with the same identity and same payload returns the original event. A retry that changes the payload is rejected.

Egress evidence is accepted only for positive transferred bytes no greater than the persisted asset size. The caller must report completed response bytes; URL issuance is not an event. The HTTP response lifecycle integration is a follow-up batch.

## Boundaries
- No provider cost or customer charge is inferred from measured quantities.
- No zero-cost fallback, currency conversion, rate-card mutation, credit deduction, payment operation or generation dispatch.
- No event is assigned a fake `job_id`.
- No production migration or deployment is authorized by this PR.
- Local/cloud/multipart handlers, actual download stream completion, deletion closure and retention scheduler wiring remain follow-up integration work (Batches 124–126).

## Verification
- `node --test server/tests/asset-resource-measurements.test.mjs server/tests/asset-resource-event-recorder.test.mjs`
- PostgreSQL integration acceptance for concurrent interval submissions and rollback on checkpoint failure must run against isolated staging before this migration is approved for any environment.
