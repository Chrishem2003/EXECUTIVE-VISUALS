# Batch 43 — Verified Job Profitability & Credit Economics

## Objective
Close the gap between provider-cost forecasts, reconciled actual spend, customer credit consumption and recognized revenue. Report profitability per completed job and per accepted deliverable without treating platform credits as cash.

## Delivered in this batch
- A deterministic pure calculator in `server/verified-job-profitability.mjs`.
- Requires a typed forecast, same-currency verified revenue allocation, accepted/rejected output counts and at least one source-evidenced actual cost line.
- Reports actual cost per accepted output, forecast variance, credit usage, acceptance rate, recognized revenue per credit, contribution and gross margin.
- Rejects duplicate source IDs, mixed currencies, unverified revenue, malformed evidence digests and missing actual costs.
- Unit tests cover profitable calculations and critical evidence/currency boundaries.

## Revenue and credit accounting rule
Customer credits are an internal usage unit, not money. The calculator deliberately does not convert credits to USD or UGX. `recognizedRevenueMinor` must be allocated by a trusted finance process from verified subscription/top-up revenue. Subscription entitlement, promotional credits, purchased top-ups, refunds and chargebacks must remain separately classified by that upstream ledger.

## Actual-cost evidence hierarchy
Use provider-reported usage and invoice-reconciled costs first. Invoice totals alone are not job-level attribution. Each cost line must carry a unique source ID, currency, evidence reference and SHA-256 digest. The calculator validates metadata and digest shape; it does not fetch source files or independently prove authenticity.

## Explicit exclusions
- No hardcoded vendor prices or seeded rate cards.
- No automatic USD/UGX FX conversion.
- No guessed revenue-per-credit ratio.
- No arbitrary shared-overhead allocation.
- No automatic credit price changes, customer debits/refunds or ledger postings.
- No provider generation, live payment, migration, production deployment or paid infrastructure.

## Next integration gate
Connect this pure calculator to a finance-admin-only read endpoint that joins job IDs to verified credit-debit events, subscription/top-up revenue allocations and invoice-reconciled cost-attribution links. Add a read-only staging report and reconcile sample jobs end-to-end before customer-facing margin or credit prices are published.
