# Batch 75 — Fee-aware mixed subscription workload margins

**Status:** implemented on a draft branch; CI verification pending.  
**Base:** Batch 74 / PR #809 commit `273714febdef74c4c563a9d2a2f3eb539c4b3384`.

## What changed

- The mixed subscription workload calculator now applies the same server-owned pricing assumptions used by the customer credit quote policy.
- For each draft plan and administrator-defined monthly workload, it reports estimated provider cost in minor units, payment fee, support reserve, contribution after those modeled costs, contribution margin basis points, target margin and an explicit assessment.
- Provider costs are rounded upward to minor currency units for conservative scenario reporting.
- The fixed payment fee is converted from USD micros to minor units with upward rounding.
- A workload that exceeds the included monthly credit allowance is marked `not_applicable_credit_shortfall`; the calculator does not pretend included-plan margins apply when the workload cannot be covered by the allowance.
- Custom-price Enterprise remains `custom_price_required`.
- The Financial Command Centre now renders a readable table of workload credit fit, provider cost, payment fee, support reserve, modeled contribution, margin and assessment.
- Regression tests cover fixed payment fees, support reserves, below-target margins, credit shortfalls, custom pricing and invalid pricing assumptions.

## Safety and interpretation

- This remains a read-only scenario calculator over private draft plan hypotheses.
- No subscription plan, included credit allowance, wallet, ledger, payment, checkout or customer price is changed.
- Provider spend remains dated list-price forecast data. Invoice-backed historical blended cost from Batch 74 is kept separate and is not silently substituted for model-specific costs.
- Contribution deducts only provider spend, configured payment fees and support reserve. It is not net profit and excludes storage, delivery, refunds, taxes, infrastructure, acquisition and other operating costs.
- A target-margin result is a decision-support signal, not approval to publish pricing or grant credits.
- Proposed $9 / $29 / $79 / $199 prices remain test hypotheses; Enterprise remains custom-priced.

## Verification

Run:

`npm run verify:subscription-plan-economics`

The full Financial Intelligence, Billing self-service, Neon PostgreSQL integration and Quality Checks workflows must pass at the exact PR head before promotion.
