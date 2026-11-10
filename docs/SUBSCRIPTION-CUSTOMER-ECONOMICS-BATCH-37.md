# Batch 37 — Subscription Customer Economics

## Purpose
Expose customer-level subscription economics by joining the existing monthly subscription revenue snapshots, immutable service-cost ledger, credit ledger and Batch 36 workload telemetry. This is a read-only management report; it does not post revenue, mutate credit balances, charge customers or allocate shared overhead.

## API
- `GET /api/admin/finance/subscription-economics?periodMonth=YYYY-MM-01&limit=250`
- Financial administrator roles only (`owner`, `platform_admin`, `billing_admin`).
- Period must be a valid month start; limit is 1–1000.
- Backed by `executive_visuals.subscription_customer_economics_report`.

## Customer metrics
- Plan code/version, billing interval and included credit allowance from the subscription period overlapping the report month.
- Monthly recurring revenue (MRR) from the immutable subscription revenue snapshot.
- Successful subscription cash receipts, completed refunds and net cash movement from verified payment records, reported separately from MRR.
- Direct customer costs from the same-month, same-currency immutable service-cost ledger.
- Provider-invoice/provider-usage-export costs separated from other direct costs.
- Contribution and direct gross margin; negative/low-margin customer flags.
- Subscription credit grants, settled credit consumption, reversals and end-of-period credit-ledger balance.
- Multimodal workload telemetry counters, event counts and provider-cost evidence counts.

## Accounting controls
- MRR is not cash collected and is not a statutory revenue-recognition assertion.
- Only costs already posted to the service-cost ledger reduce contribution. Provider costs require reconciliation and posting before they count.
- Telemetry cost evidence and usage counters are diagnostic; they are not added to ledger costs a second time.
- Credits are operational units, never currency or profit.
- Credit-ledger balance excludes outstanding reservations; available balance can be lower.
- Shared overhead is excluded from direct customer margin and is not arbitrarily allocated.
- Customers without a revenue snapshot or verified attribution are not invented or backfilled.
- Currency groups are never summed across currencies.

## Research references
- OpenAI API usage dashboard and request-level usage: https://help.openai.com/en/articles/10478918-reviewing-api-usage-and-costs
- OpenAI monthly cost export and invoice reconciliation: https://help.openai.com/en/articles/20001072-exporting-monthly-usage-details-from-the-api-usage-dashboard
- OpenAI organization Costs API grouping by project, user, line item and API key: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
- Stripe usage-based billing: metering, rating, invoicing, predictable value metrics and bill-shock safeguards: https://stripe.com/resources/more/usage-based-pricing-strategy-for-saas

## Release status
- Migration staged for review only; not applied to Supabase.
- API route and authorization/filter tests added to build and financial CI.
- No provider calls, billing changes, production deployment or new paid infrastructure.
