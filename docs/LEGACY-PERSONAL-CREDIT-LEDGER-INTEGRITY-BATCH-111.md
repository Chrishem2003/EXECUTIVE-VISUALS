# Batch 111 — legacy personal credit ledger integrity

## Why this batch exists

The platform has an older personal credit wallet alongside the newer billing/workflow
and agency project-pool wallets. The older wallet uses credit_reservations and
credit_ledger. Batch 105 already blocks unverified reservation releases, but the
legacy ledger still had direct service-role write privileges and no database-level
available-balance floor for negative ledger entries.

## Delivered

- Reservation rows must begin in reserved state with no terminal timestamps.
- Reservation owner, job, credit amount, idempotency key, reason and creation time
  cannot be rewritten after creation.
- Settled and released reservation rows are terminal and immutable.
- Existing job finalizers may still append reconciliation metadata to a reserved
  reservation without changing its identity or state.
- Negative legacy ledger writes take an owner advisory lock and cannot reduce the
  ledger balance below outstanding reserved credits.
- A settlement ledger debit must identify the exact reserved row, owner, job,
  credit amount and canonical idempotency key.
- The ledger is append-only.
- Direct service-role INSERT/UPDATE/DELETE privileges are revoked from both legacy
  credit tables. Existing security-definer grant/reserve/settle functions retain
  the ability to perform approved mutations.
- Batch 105 no-charge release protection remains active.

## Integration coverage

The disposable PostgreSQL test verifies:
- Grant 100 credits and reserve 60; available balance is exactly 40.
- Service-role direct ledger and reservation writes are denied.
- A negative ledger adjustment that would consume reserved credits is rejected.
- The approved settlement RPC debits exactly the 60 reserved credits.
- Exact settlement replay is idempotent.
- A post-settlement debit cannot drive the wallet below zero.
- The legacy release RPC remains blocked without verified no-charge evidence.

## Scope and safety

This protects the legacy personal credit wallet. It does not enable provider calls,
customer refunds, payments, production migration or deployment. No existing credits
or reservations are changed by the migration itself.
