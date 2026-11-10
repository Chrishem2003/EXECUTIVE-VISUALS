# Batch 26 — Measured Shared-Cost Allocation & Fully Loaded Profitability

## Delivered

- Effective-dated, immutable allocation policies that bind a cost category and currency to a specific measured consumption driver.
- Supported drivers:
  - AI inference: successful input + output tokens
  - Image generation: successful image count
  - Video generation: successful video seconds
  - Render compute: measured FFmpeg, GPU or CPU seconds
  - Storage: measured GB-days
  - Egress: measured GB
- Explicit administrator-triggered allocation runs for one month, currency and cost category.
- Shared cost pools are drawn from the existing immutable service-cost ledger where `owner_id IS NULL`; customer-attributed direct costs are never redistributed.
- Driver events must be measured for the same month and attributed to a customer. AI usage drivers include successful events in the allocation currency only; foreign-currency and unpriced AI usage do not distort a currency-specific pool.
- At least two measured customer recipients are required by default; policies can set a higher minimum.
- Deterministic largest-remainder rounding allocates integer minor currency units and reconciles the allocation exactly to the source pool.
- Immutable allocation batches preserve source event count and fingerprint, policy, driver totals, recipient counts, allocated amount and unallocated amount.
- Immutable customer allocation lines preserve each customer's measured units, event count, share and allocated amount.
- Profitability trends now retain direct contribution/margin and add allocated shared cost, fully loaded contribution/margin, negative fully-loaded customer count and remaining unallocated shared costs.
- Customer-level trend rows now show MRR, direct costs, allocated shared costs, fully loaded costs, direct contribution and fully loaded contribution/margin; recipients without a revenue snapshot remain visible in the allocation ledger but are not assigned a fabricated margin.
- Financial Command Centre exposes policy creation, explicit allocation runs, batch history and customer-level allocations.

## Accounting safeguards

- Allocation is a separate management-accounting showback layer. It never edits, reverses or rewrites source service-cost ledger entries.
- Direct customer costs are not redistributed.
- Currency pools are isolated; no cross-currency conversions or blended totals are inferred.
- Costs without a suitable causal telemetry driver (including support, payment processing and miscellaneous costs) remain unallocated.
- Missing, unpriced or unattributed driver evidence is not fabricated. A pool without an active policy or sufficient measured recipients remains unallocated.
- Each period/currency/category can be allocated only once. Repeated runs return the immutable existing batch.
- The source pool includes posted expenses and reversals for the same month/category/currency; non-positive net pools are not allocated.
- Largest-remainder rounding ensures the sum of allocation lines equals the shared pool exactly.
- This is showback/management accounting, not a customer invoice, statutory ledger posting or audited financial statement.

## APIs

- `GET /api/admin/finance/shared-cost-allocations?months=12`
- `POST /api/admin/finance/shared-cost-allocation-policies`
- `POST /api/admin/finance/shared-cost-allocations/run`
- Existing `GET /api/admin/finance/profitability-trends?months=12` now returns direct and fully loaded metrics.

All routes require a financial administrator role. Database functions are service-role only.

## Validation

The disposable PostgreSQL integration test creates three customer usage streams with 100, 300 and 100 successful tokens, adds a large foreign-currency usage fixture, and allocates a shared 1001-minor-unit pool. It verifies the deterministic 200/601/200 allocation, exact reconciliation, immutable one-run idempotency, customer-level evidence, fully loaded profitability, and rejection of unsupported support-cost drivers. API tests cover administrator authorization, policy-driver compatibility, month/currency/category validation and RPC binding.

## Rollout

Draft PR only. CI applies migrations through Batch 26 to disposable PostgreSQL. Do not merge, run production migrations, deploy, enable automatic allocation, change customer invoices, or change provider routing without separate review and explicit approval.
