# Batch 45 — Customer Lifetime & Acquisition Economics

## Delivered

Batch 45 extends the existing Batch 19 acquisition ledger and Batch 20 profitability model. It does not create a parallel spend ledger or overwrite earlier calculations.

- Realized customer contribution-to-date from captured monthly subscription MRR snapshots less same-month, same-currency directly attributed service costs.
- Discounted predicted lifetime contribution using observed consecutive-month paid-customer retention.
- CAC by channel and by individual campaign using same-month, same-currency acquisition spend and immutable first-touch paid-customer attribution.
- Actual payback month when recorded cumulative contribution first reaches customer CAC.
- Modeled payback using CAC divided by current positive monthly direct contribution.
- Retention-adjusted LTV:CAC, after-CAC contribution and growth-quality classifications.
- Evidence-volume forecast confidence labels and explicit report limitations.
- Protected finance-admin GET endpoint and integrated Financial Command Centre workspace with adjustable discount rate and projection horizon.
- Disposable PostgreSQL integration and API/UI contract tests.

## Definitions and model rules

### Realized contribution to date

For each customer and currency:

`Realized contribution to date = Σ (monthly subscription MRR − same-month directly attributed service costs)`

Only recorded snapshots from the customer's recorded paid cohort month through the selected report month are included. The result is not a complete lifetime if the monthly snapshot process began after the customer was acquired.

### Predicted lifetime contribution

The report adds future contribution to realized contribution to date:

`Predicted lifetime contribution = realized contribution to date + Σ [current monthly direct contribution × retention^t / (1 + monthly discount rate)^t]`

- Retention is measured from actual adjacent monthly snapshots for the same currency: retained paid customers divided by paid customers in the preceding captured month.
- Future contribution holds current monthly direct contribution constant over the chosen horizon (1–60 months).
- The default model inputs are a 1% monthly discount rate (100 basis points) and a 36-month projection horizon.
- A prediction is withheld when no consecutive-month retention evidence exists or current direct contribution is not positive.
- This is a transparent management model, not a guaranteed forecast or a calibrated statistical survival model.

### CAC by channel and campaign

`CAC = same-month, same-currency recorded acquisition spend / distinct attributed new paid customers`

Campaign attribution is matched on the exact period, channel, campaign and currency. Channel totals aggregate their campaign spend and attributed customers. Spend without attribution and attribution without spend are shown as evidence gaps; neither side is silently estimated.

### Payback and growth quality

- Actual payback is the first observed monthly snapshot where cumulative cohort contribution reaches the attributed CAC.
- Modeled payback is CAC divided by current positive monthly direct contribution.
- LTV:CAC uses predicted lifetime contribution divided by CAC.
- `strong_unit_economics` requires modeled LTV:CAC of at least 3×; below-CAC lifetime value is classified as `value_below_acquisition_cost`; intermediate economics are flagged for monitoring. The 3× threshold is a screening heuristic, not a universal benchmark or an automatic instruction to increase spend.
- Missing CAC or lifetime evidence receives an explicit insufficient-evidence classification.

### Confidence labels

Confidence is an evidence-volume label, not a statistical confidence interval:
- High: at least six observed consecutive-month intervals and 50 customer-month retention transitions.
- Moderate: at least three intervals and 10 transitions.
- Low: at least one observed interval.
- Insufficient history: no valid consecutive-month transitions.

## Controls and data integrity

- Reads only existing append-only revenue snapshots, direct service-cost events, acquisition spend and first-touch attribution.
- No historical snapshots, spend, attribution, costs, retention or customer records are fabricated.
- Currency groups remain separate; no FX conversion is introduced.
- Shared overhead is excluded unless already posted through an approved customer-level allocation.
- The report RPC is finance-admin-only and read-only.
- Model assumptions are bounded: discount rate 0–5,000 basis points; projection horizon 1–60 months.
- The existing acquisition and service-cost ledgers remain the source of truth.
- No subscriptions, payments, pricing, customer entitlements, provider operations or acquisition spend are changed by report execution.

## Verification

The Batch 45 disposable PostgreSQL integration verifies:
- Idempotent acquisition spend recording.
- Actual contribution across observed cohort snapshots and direct cost ledger entries.
- Exact campaign CAC and channel CAC reconciliation.
- Retention-based discounted lifetime projection and LTV:CAC.
- Actual payback month and low-confidence classification with limited history.
- Growth-quality classification and read-only report behavior.

API tests cover finance-admin authorization, invalid filter rejection, actor binding, model-parameter bounds and report response handling. UI contract tests cover the Batch 45 controls and evidence presentation.

## Release safeguards

- Changes are staged on `feat/customer-ltv-acquisition-economics-batch-45`.
- The work is intended as a stacked draft against the Batch 37–44 review branch.
- No production migration, merge, deployment, payment action, provider execution, bank connection or new paid infrastructure is authorized.
