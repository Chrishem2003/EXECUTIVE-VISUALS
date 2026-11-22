# Batch 44 — Per-generation cost reconciliation

## Objective

Give finance administrators an evidence-backed view of each metered AI operation, keeping catalog estimates, provider-reported usage, invoice-confirmed provider costs and customer credit units distinct.

## Delivered

- Added admin-only `GET /api/admin/finance/ai-usage-reconciliation`.
- Returns a bounded, newest-first list of AI usage events with optional month filtering.
- Joins usage events to immutable `financial_cost_attribution_links` created only after exact provider invoice reconciliation and explicit posting.
- Joins job-linked customer credit reservations to show reserved and settled customer credit units.
- Computes estimate-versus-invoice variance only when an estimate and invoice-confirmed amount share the same currency.
- Reports missing, ambiguous and invoice-confirmed attribution separately.
- Added a per-generation cost reconciliation table to the Financial Command Centre, including provider/model, job, operation, estimate or reported cost, invoice-confirmed amount, variance and customer credit units.
- Added API tests for finance-admin authorization, pagination/month validation, exact invoice attribution, variance calculation and job-linked customer credit state.

## Financial semantics

- `catalog_estimate` is a forecast, not an invoice or cash expense.
- `provider_reported` is provider-reported usage evidence, but is not labelled invoice-confirmed until an immutable invoice attribution link exists.
- `invoice_confirmed` is shown only when the verified invoice posting process has created the corresponding attribution link.
- Customer credits are consumption units. They are not treated as cash revenue or directly netted against provider cost.
- Estimate variance is calculated only for same-currency estimate and invoice evidence. No implicit FX conversion is performed.
- Shared overhead remains separate; this view does not claim fully loaded customer profitability.

## Security and operational controls

- All reads require a finance administrator role.
- Pagination is bounded to 1–100 rows and offset 0–100,000.
- Optional reporting month must be the first day of a valid month.
- Queries use the service-role database client after authorization and return a narrow set of fields.
- No customer credentials, evidence JSON, idempotency keys or private storage paths are exposed.
- No write, invoice import, posting, provider call, credit mutation, payment, migration, production deploy or merge is performed by this batch.

## Verification

CI must pass on the exact pull request head. The batch reuses the existing usage, invoice attribution and credit reservation tables; it introduces no schema migration.
