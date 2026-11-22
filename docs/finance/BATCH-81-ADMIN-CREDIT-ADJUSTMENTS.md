# Batch 81 — Audited administrator credit adjustments

**Status:** implementation branch; disposable PostgreSQL and full CI verification required.  
**Base:** Batch 80 verified credit-pack top-ups.

## What this adds

A finance-admin-only adjustment API and append-only audit history:
- `POST /api/admin/billing/credit-adjustments` applies a positive compensation grant or a negative customer credit correction.
- `GET /api/admin/billing/credit-adjustments` lists the latest adjustments, optionally scoped to a customer.
- Both API and database independently verify the actor's `owner`, `platform_admin` or `billing_admin` role.
- Each adjustment records actor, customer, signed credit delta, resulting balance, reason, evidence, ledger reference, timestamp and idempotency key.

## Accounting treatment

Positive administrator adjustments are inserted as normal wallet grant rows with `sourceType=admin_compensation`. The existing Batch 71 provenance trigger classifies them as `non_revenue` with zero allocatable cash revenue.

Negative adjustments use the wallet's `admin_adjustment` event type. They are rejected when the requested debit exceeds the net ledger balance. Active generation reservations already have negative ledger entries, so the debit check uses the net ledger balance and does not subtract the reservation table a second time.

## Concurrency and safety

- A transaction-scoped advisory lock serializes a global idempotency key.
- The customer billing account row is locked before the balance check and ledger write.
- Reusing a key with different actor, customer, amount, reason or evidence is rejected.
- A suspended billing account cannot be adjusted.
- Tables have RLS enabled and no client/service-role direct table grants; the service role can only invoke the guarded RPCs.
- The database rechecks admin role membership even though the API also checks it.

## Verification scenarios

The disposable PostgreSQL integration checks:
1. Positive compensation grant is posted once and classified as zero-revenue.
2. A real generation reservation is created through the existing reservation RPC.
3. A debit larger than the net available balance is rejected.
4. A debit equal to the unreserved net balance is accepted without consuming the active reservation.
5. An identical retry returns the original audit record.
6. A non-admin actor is rejected by the database function.
7. Exactly two audit records remain after one grant and one debit.

The Node tests cover role enforcement, input validation, bounded history and RPC wiring.

## Commercial and rollout gates

This batch does not activate any plan or credit-pack product, set customer-facing credit prices, call a provider, charge a customer, merge a PR or deploy a production migration. The next batch is the provider-cost-backed credit pricing and margin guard: per-model rates, retries, payment fees, storage/render costs and a configurable contribution-margin floor must be measured before publishing allowances or credit packs.
