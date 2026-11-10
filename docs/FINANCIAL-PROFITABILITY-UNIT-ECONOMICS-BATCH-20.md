# Batch 20 — Financial Profitability & Unit Economics

## Delivered

Batch 20 extends the Financial Command Centre with an auditable operating-cost ledger and evidence-backed customer profitability.

- Append-only service-cost events in currency minor units.
- Direct customer cost attribution and separately reported shared overhead.
- Cost categories for AI inference, video/image generation, render compute, storage, egress, payment processing, support and other.
- Evidence source classification for provider invoices/usage exports, cloud invoices, payment processors, manual receipts and other evidence.
- Idempotent cost recording and referenced partial reversals.
- Reversal controls that prevent cumulative credits exceeding the original expense.
- Current-month direct gross contribution and direct gross margin by currency.
- Customer-level MRR, direct costs, contribution margin, CAC and CAC payback where the evidence exists.
- Directional gross-profit LTV and LTV:CAC only when an adjacent monthly snapshot provides observed logo churn.
- Shared overhead shown separately rather than silently allocated to customers.
- Protected admin APIs and financial audit events for every cost write/reversal.
- Financial Command Centre profitability tables and cost-entry control.
- Audited CSV export of the service-cost evidence ledger.

## Metric definitions

### Direct customer contribution

For a customer and snapshot month:

`Direct contribution = subscription MRR - directly attributed service costs`

`Direct gross margin % = direct contribution / subscription MRR × 100`

The report includes only costs assigned to the customer, in the same currency and snapshot month. It does not infer a customer's share of unassigned platform overhead.

### Shared overhead

Costs without a customer owner are reported by category and currency. No arbitrary allocation is applied. A future allocation policy can be introduced only with an explicit documented driver, such as measured storage GB-days, render minutes, inference units or transaction count.

### CAC and payback

CAC is derived from Batch 19's acquisition ledger and first-touch paid-customer attribution:

`Channel CAC = same-month, same-currency channel spend / distinct attributed paid customers`

`CAC payback months = customer CAC / current monthly direct gross contribution`

Payback is unavailable when CAC evidence is absent or monthly direct contribution is non-positive.

### Directional gross-profit LTV

When a real immediately preceding monthly snapshot exists:

`Monthly logo churn = customers lost from opening paid snapshot / opening paid customers`

`Directional gross-profit LTV = current monthly direct contribution / observed monthly logo churn`

`LTV:CAC = directional gross-profit LTV / customer CAC`

The LTV estimate is withheld when there is no adjacent snapshot or no churn observed in the comparison window. A single observed monthly churn interval is directional, not a mature lifetime model; it must not be presented as a guaranteed forecast.

## Evidence integrity and controls

- Amounts are stored as integer minor units with explicit ISO currency.
- Currency totals are never combined.
- Customer attribution is optional; null owner means shared overhead.
- Costs are append-only. Corrections use a negative reversal linked to an original expense.
- Reversals must match the original month, customer, category and currency.
- Cumulative reversals cannot exceed the original expense.
- Idempotency keys protect against duplicate submissions and replayed reversals.
- Database functions independently verify administrator role and write financial audit events.
- No model prompt, media, API credential or payment secret is stored as cost evidence.
- Provider usage exports and invoices remain the source of truth; local telemetry with unknown pricing is not converted into invented dollar costs.

## Validation

Disposable PostgreSQL billing CI applies Batch 20 after Batch 19. Integration coverage verifies:
- Direct cost insertion and idempotent replay.
- Partial reversal and over-reversal rejection.
- Net direct cost reconciliation.
- Customer contribution, CAC and payback calculation.
- Shared overhead is reported separately and excluded from customer direct margin.
- LTV is withheld when the comparison period has zero observed churn.

API tests verify admin authorization, cost input validation, actor binding, reversal references and profitability overview access. The billing workflow also runs TypeScript, API syntax and financial integration checks.

## Operational use

1. Capture the current month's revenue snapshot.
2. Record provider invoices/usage exports and cloud/payment processor costs.
3. Attribute a cost to a customer only when a trustworthy source identifies that customer. Otherwise leave owner blank.
4. Record provider credits as reversals linked to the original expense.
5. Review direct contribution and margin by currency.
6. Review shared overhead separately and establish an explicit allocation policy before distributing it.

## Important limitations

- This is management accounting, not statutory revenue recognition, tax accounting, cash accounting or an audited income statement.
- Subscription MRR is a run-rate metric, not cash collected.
- The first version uses manually recorded evidence; it does not yet automatically ingest provider invoices, cloud bills or generation-level usage from external systems.
- Shared overhead is not allocated without a defensible measured driver.
- LTV:CAC is a directional cohort indicator until multiple monthly observations and mature churn cohorts are available.
- No customer pricing, subscription entitlement, provider execution or payment behavior is changed by this batch.
