# Batch 39 — Revenue Movement & Cohort Intelligence

## Delivered
- Protected administrator endpoint: `GET /api/admin/finance/revenue-movement`.
- Monthly recurring-revenue bridge across the two latest consecutive captured snapshots.
- Separate new business, expansion, contraction and churn movements.
- Per-currency opening and closing MRR, customer counts and reconciliation delta.
- Twelve-snapshot observed cohort retention curve with logo retention and revenue retention.
- Explicit first-observed baseline month for each paid cohort and currency.
- Read-only SQL reporting function; no subscription, payment, ledger or snapshot mutation.
- Financial Command Centre panel with bridge and cohort tables.

## Accounting and evidence boundaries
- MRR is a run-rate measure, not cash flow, billings or recognized revenue.
- A monthly bridge is withheld if the latest two snapshots are not consecutive.
- Cohort baselines use the first observed monthly snapshot for that cohort/currency.
- Missing months are not interpolated and no churn or revenue is fabricated.
- Currency totals are never combined.

## Verification
- API tests verify administrator authorization and the returned reporting contract.
- PostgreSQL integration fixtures cover new customers, expansion, churn, cohort logo retention, revenue retention and exact bridge reconciliation.
- Billing self-service CI applies Batch 39 after the prior revenue and customer economics migrations on a disposable PostgreSQL 16 database.

## Release controls
- Changes remain on the Batch 37 review branch and draft PR #335.
- No production migration, production deployment, payment action or paid infrastructure change.
