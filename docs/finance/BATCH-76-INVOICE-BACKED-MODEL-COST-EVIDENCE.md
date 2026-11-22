# Batch 76 — Invoice-backed model and operation actual costs

**Status:** implemented on a draft branch; exact-head CI verification pending.  
**Base:** Batch 75 / PR #810 at `5bf59da47980df987b94faab8739d4e821f99442`.

## What changed

- Adds a pure read-only evidence calculator over immutable `financial_cost_attribution_links`.
- Uses exact provider, response/request model, operation and currency dimensions.
- Requires the invoice import, invoice line, reconciliation event and service-cost ledger references to be present and valid.
- Requires exactly one attribution link per usage event.
- Reports partial invoice coverage without extrapolating missing costs.
- Requires complete period sampling and at least five distinct jobs per model/operation/currency group before showing a verified total.
- Reports verified total actual provider cost and conservative average cost per usage event.
- Integrates the evidence into the finance-admin subscription economics response and Financial Command Centre.
- Keeps invoice-backed historical actuals separate from provider rate-card forecasts and blended platform-credit cost.

## Safety

- Finance-admin-only existing endpoint; all database reads remain read-only.
- No new tables or migrations.
- No invoice posting, ledger writes, customer credit grants, subscription plan changes, checkout activation, payment calls, provider generation or deployment.
- Unmatched, duplicate, incomplete, truncated, cross-currency or insufficient-sample evidence does not produce a verified actual-cost total.
- Actual model costs are historical evidence, not a guaranteed future rate or customer credit price.

## Verification

Run `npm run verify:subscription-plan-economics`.

Full Financial Intelligence, Billing self-service, Neon PostgreSQL integration and Quality Checks must pass at the exact PR head before promotion.
