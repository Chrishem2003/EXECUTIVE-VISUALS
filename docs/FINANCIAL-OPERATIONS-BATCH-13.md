# Financial Operations — Batch 13

## Scope

Batch 13 extends the Batch 12 Financial Command Centre with deadline-aware chargeback operations and a controlled evidence-readiness workflow.

### Delivered

- Admin-only dispute queue sourced from provider-backed `chargeback_cases`.
- Response-deadline counters for overdue cases and cases due within 72 hours.
- Private-object evidence metadata for payment receipts, service delivery, customer communications, refund records, terms acceptance and other supporting material.
- Evidence lifecycle states: `missing`, `uploaded`, `verified`, and `rejected`.
- Evidence updates are performed through a role-checked database function and emit reason-bearing financial audit events.
- Evidence object references must be relative private-storage paths; public URLs, absolute paths and traversal segments are rejected.
- Finance workspace exposes the queue and administrative evidence controls.
- PostgreSQL integration and API tests cover access control, deadline calculations, evidence status changes and path validation.

## Security and operational boundaries

- This batch does not upload binary files or create public object URLs. Evidence must already exist in a private storage location and only its relative object path is recorded.
- This batch does not submit evidence to Flutterwave. Provider submission, provider acknowledgements and dispute outcomes remain separate workflows.
- Support roles cannot access the finance dispute queue or evidence mutation endpoint.
- Every evidence update requires a reason and is recorded in the append-only financial audit trail.
- No production migration, production payment, provider dispute submission, merge or deployment is authorized by this batch.

## Validation

The disposable PostgreSQL CI workflow applies the Batch 12 and Batch 13 migrations in sequence, then runs the billing lifecycle and finance integration SQL. Node tests cover the dispute queue, role gating and evidence update validation.

## Rollout gates

1. Exact-head CI passes.
2. Apply the migration to isolated Supabase staging only after schema review.
3. Verify private object storage bucket policy and admin authorization in staging.
4. Add a dedicated evidence upload path with MIME sniffing, size limits, malware scanning and retention policy before accepting new evidence files.
5. Implement Flutterwave dispute submission only after the merchant account and provider endpoint permissions are verified.
