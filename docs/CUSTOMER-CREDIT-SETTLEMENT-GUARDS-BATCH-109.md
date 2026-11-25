# Batch 109 — customer credit settlement refund and overdraft guard

## Financial protection

This batch hardens the billing/workflow wallet and agency project-shared wallet.
It does not introduce an automatic refund path.

- A settlement cannot reduce actual customer credits below the reserved amount.
- A positive `generation_refund` ledger insertion is blocked, including direct
  service-role inserts.
- A settlement that requires additional credits is allowed only when the relevant
  billing account or project pool already has enough available balance.
- Negative ledger entries cannot drive either wallet below zero, including direct
  inserts that bypass the settlement RPC.
- Reservation rows must begin in `reserved`, cannot be inserted directly as settled,
  and become immutable after settlement.
- Direct service-role updates to billing/project reservation rows are revoked;
  changes must go through the guarded security-definer settlement RPCs.
- Exact settlement replay remains idempotent. Funded overages remain chargeable.

## Customer fairness and refund boundary

This is deliberately conservative. If actual usage would justify a lower customer
charge than the original reservation, the reservation is not automatically refunded.
The operation fails with `BILLING_CREDIT_REFUND_REQUIRES_VERIFIED_RECONCILIATION`.
The reservation remains held until a separately reviewed reconciliation flow can
link authenticated provider outcome evidence, actual cost, the current customer
pricing policy and an auditable refund decision.

A provider's no-charge result alone is not sufficient to release customer credits:
storage, compute, moderation, retries, support or other costs may still have occurred.
The Batch 105 release guard remains in force for personal, billing/workflow and
project-shared wallets.

## Tests

The disposable PostgreSQL integration script covers:
- Billing wallet under-reserved settlement rejection.
- Project pool under-reserved settlement rejection.
- Direct positive refund-ledger insertion rejection.
- Direct reservation mutation denial.
- Additional settlement charge blocked when the wallet/pool lacks funds.
- Funded overage settlement and exact replay.
- Direct negative ledger insertion cannot overdraw either wallet.

## Deliberate limitation

The evidence JSON accepted by these existing settlement RPCs is still a structured
server input, not a database-verified provider receipt. This batch therefore blocks
all automatic refunds rather than trusting caller-supplied evidence. A subsequent
batch must link Batch 107's durable provider outcome evidence to each reservation and
verify the customer-price recalculation before any refund can be authorized.

No production migration, merge, deployment, payment activation, provider call or paid
infrastructure change is included.
