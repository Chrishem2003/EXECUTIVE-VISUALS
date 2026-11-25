# Batch 107 — durable provider outcome evidence

## Delivered

This migration adds an append-only PostgreSQL evidence register for durable cloud
video-generation tasks. It records the authenticated provider outcome envelope
produced by the trusted adapter verifier introduced in Batch 106.

Stored evidence includes provider and provider task identity, provider account and
route, model, provider evidence ID, final provider state, billable seconds, reference
count, audio mode, source reference, observed time, adapter identity/version,
signature algorithm and evidence digest.

For known provider charges it stores actual cost in integer micro-units of the
quoted currency, the task's immutable estimated provider cost, and the actual-minus-
estimated variance. Unknown outcomes have no fabricated actual cost and remain
reconciliation items.

## Database protections

- The write RPC is executable only by `service_role` and additionally requires the
  Supabase service-role JWT claim.
- The RPC locks and verifies the durable task row, provider task ID, provider,
  model, approval/project/owner scope, currency and terminal state.
- Evidence IDs are idempotent per provider task. Exact replay returns the original
  record; a replay with a different digest fails.
- Evidence history is append-only. Direct insert is revoked; update/delete are
  rejected by a database trigger.
- Stale (older than 90 days), future-dated, malformed, mismatched and invalid
  charged/no-charge/unknown amount combinations are rejected.
- Actual provider cost variance is recorded for finance review.

## Explicit non-goals / safety

The database does not verify HMAC signatures itself. The trusted server adapter must
call the Batch 106 verifier first and pass its verified digest; the database accepts
writes only from the service-role backend. Never expose this RPC to customer clients
or accept a customer-supplied digest as proof.

Most importantly, provider cost evidence is **not** customer-credit authorization.
This batch does not settle or release personal, subscription/workflow, or agency
project-wallet reservations. The Batch 105 fail-closed release guards remain
unchanged. A successful provider no-charge report does not imply customer work was
free, and an unknown provider outcome never releases a hold.

The integration script is wired into the disposable PostgreSQL cloud-video CI job.
It tests task binding, actual-cost variance, exact replay, conflicting replay,
no-charge validation, unknown-outcome handling, append-only enforcement and the
invariant that recording provider evidence does not change a reserved customer
credit hold.

## Remaining financial work

Next, implement one atomic settlement/release service across all three wallet types,
with trusted evidence lookup, reservation-to-provider-task linkage, customer-credit
quote reconciliation, actual usage/credit policy, overage handling, concurrency and
replay tests. Do not bypass the Batch 105 triggers until that end-to-end path is
proven in disposable PostgreSQL.
