# Batch 71 — Verified credit revenue allocation

**Status:** draft implementation; disposable PostgreSQL verification required  
**Date:** 2026-11-22  
**Scope:** additive, staging-first. No production migration, live payment activation, paid provider generation, or deployment is authorized.

## Objective

Connect a verified customer payment to the exact generation-credit grant it funds, then allocate the grant's revenue to settled generation jobs as credits are consumed. This closes the gap between the legacy payment/credit ledger and the generation wallet without treating platform credits as money.

## Source-of-funds rules

- A successful, verified one-time credit-pack payment is a paid source. Its gross payment amount and ISO currency are allocated proportionally across the granted credits as those credits are consumed.
- A verified subscription purchase or renewal creates a subscription-allowance source, but its credit-revenue amount remains pending. Finance must approve the share of subscription revenue attributable to included generation credits. The whole subscription payment is never assumed to be generation revenue.
- Promotional and administrator-compensated grants are explicit zero-revenue sources.
- Existing grants without source evidence, project-pool transfers and otherwise unlinked credits remain unattributed. A migration backfills pre-existing generation-wallet grant rows as provenance-only unattributed source records; it does not add credits or revenue. They cannot inherit revenue from a paid source.
- All amounts use integer minor units. No automatic FX conversion is performed.

## Transaction flow

1. The existing immutable credit_ledger receives a payment-backed purchase_grant only after the provider payment is verified.
2. A database trigger mirrors supported successful top-up and subscription grants into billing_credit_ledger using a deterministic idempotency key.
3. A revenue source record links the generation-wallet grant to the verified payment and source type.
4. The existing generation reservation is settled using provider evidence.
5. The settlement transaction allocates actual consumed credits FIFO across the customer's source grants.
6. Prepaid revenue is recognized proportionally using cumulative integer-minor-unit rounding. Unused credits retain their remaining source value.
7. Subscription allocations remain pending until a finance administrator records an explicit credit-component split. The approval is append-only and does not rewrite the original source or allocation.
8. The job-cost report combines the recognized revenue with invoice-backed provider costs. Gross margin is shown only when currencies match and both sides are complete.

## Controls and invariants

- Only successful payments with a non-null verified timestamp and matching immutable payment credit grants qualify as paid sources.
- Top-up revenue must equal the verified payment amount and currency.
- Subscription revenue split must be no greater than the verified subscription payment and must use the payment currency.
- Revenue-source, allocation and review tables are not directly writable by the service role; writes occur through security-definer RPCs or the controlled credit-ledger trigger.
- Revenue allocation runs are idempotent per settled reservation.
- FIFO source allocation is serialized on the wallet account lock to prevent concurrent jobs from consuming the same source units.
- Failed, released and unverified reservations do not recognize revenue.
- Mixed currencies, pending subscription splits and unattributed credit units block profitability rather than being guessed.
- Gross margin currently excludes processing fees, refunds, chargebacks, taxes, storage, rendering, support and other operating costs. Those costs must be reconciled before calling this fully loaded margin.

## Finance API and interface

The existing finance-admin-only GET /api/admin/finance/job-cost-coverage report now exposes:
- recognized revenue and its currency;
- revenue allocation completeness;
- gross margin percentage only when verified provider cost and revenue share the same currency;
- explicit missing, pending, mixed-currency and unattributed statuses.

The Financial Command Centre shows these fields beside provider cost and consumed credits.

## Still required before production

- Integrate the Batch 65/66 top-up checkout stack with this migration and run the complete combined PR stack; the trigger is designed to pick up its verified credit_ledger grant.
- Reconcile historical legacy payment-ledger entries and project-pool transfers separately; existing generation-wallet grants are only marked unattributed, with no balance changes or historical payment grants.
- Add payment-fee, refund and chargeback allocation and project shared-pool source transfers.
- Add the finance-admin UI for subscription credit-component split approvals and review history.
- Verify the entire combined billing, wallet, provider invoice and profitability stack on a clean disposable PostgreSQL database.
- Review accounting treatment, local tax and payment-provider settlement rules before production activation.

## Test evidence

scripts/verified-credit-revenue-allocation-postgres-integration-batch-71.sql verifies:
- verified paid credit-pack grants are automatically mirrored to the generation wallet;
- revenue is allocated only after settlement and in FIFO source order;
- promotional credits contribute zero revenue;
- subscription credits remain pending until explicit finance approval;
- approved subscription splits can resolve historical consumed-credit allocations;
- repeated settlement does not double-allocate;
- mismatched currencies and incomplete provider-cost evidence do not produce profitability.
