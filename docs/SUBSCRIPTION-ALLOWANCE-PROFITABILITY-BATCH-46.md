# Batch 46 — Subscription Allowance & Profitability Engine

**Status:** scenario engine implemented; customer allowances remain unpublished.  
**Date:** 2026-11-22  
**Base:** Batch 45 Seedance 2.5 Flash branch.  
**Scope:** read-only financial modelling. No checkout, entitlement grant, credit-ledger write, provider execution, migration or deployment.

## Why this batch exists

The proposed monthly prices remain hypotheses:

| Plan | Monthly price |
|---|---:|
| Starter Creator | USD 9 |
| Professional Creator | USD 29 |
| Studio | USD 79 |
| Agency | USD 199 |
| Enterprise | Custom contract |

The four fixed-price plans are represented in the simulator in USD minor units. Enterprise is intentionally excluded from fixed-price calculations because it requires negotiated terms.

## Implemented

- Added `server/subscription-allowance-profitability.mjs`.
- Added bounded, integer-minor-unit modelling for payment fees, fixed payment fees, refund reserves, support reserves, infrastructure reserves and target gross margin.
- Added a provider-cost budget per plan after payment/refund reserves and target margin.
- Credit allowances are calculated only when an explicit provider cost per platform credit and approved measured evidence are supplied.
- Evidence must identify its source, rate-card version, sample job count and valid measurement period.
- Without evidence, the engine returns `estimatedIncludedCredits: null` and `awaiting_approved_cost_evidence`.
- Every result is marked `publishable: false`; this scenario tool cannot update a plan, entitlement, subscription or credit ledger.
- Added a focused verification script: `npm run verify:subscription-allowance-profitability`.

## Calculation

All monetary inputs are USD cents (integer minor units).

1. Payment fee = ceiling(monthly price × payment fee basis points) + fixed payment fee.
2. Refund reserve = ceiling(monthly price × refund reserve basis points).
3. Net after payment/refund reserves = max(0, price − payment fee − refund reserve).
4. Total cost ceiling = floor(net × (1 − target gross margin)).
5. Provider budget = max(0, total cost ceiling − support reserve − infrastructure reserve).
6. Scenario credit allowance = floor(provider budget ÷ measured average provider cost per platform credit).

The simulator does not convert Runway provider credits into Executive Visuals credits. The supplied per-platform-credit cost must be calculated from reconciled provider usage and the applicable platform credit consumption history. A rate-card estimate alone is not actual cost evidence.

## Illustrative test scenario (not recommended commercial settings)

The test suite uses a deliberately explicit scenario:
- target gross margin: 70%;
- payment fee: 3.5% plus USD 0.30;
- refund reserve: 2%;
- support reserve: USD 0.20;
- infrastructure reserve: USD 0.30;
- measured provider cost per platform credit: USD 0.02.

This yields scenario-only allowances of 98 / 381 / 1,090 / 2,791 credits for Starter / Professional / Studio / Agency. These are test fixtures, **not approved plan allowances or price recommendations**. Change any assumption and the output changes.

## Safety / release gates

- No plan credits are published or granted.
- No database migration was created or applied.
- No payment provider was called or configured.
- No customer balance, subscription or ledger entry was changed.
- No production resource, deployment or provider adapter was changed.
- Finance approval and actual settled-cost evidence are still required before publishing allowances.

## Next integration step

Connect the engine to a read-only admin scenario workspace with editable assumptions, measured-cost evidence import, plan-by-plan cost budgets, margin sensitivity and a separate approval workflow. Then connect customer-facing generation quotes to the existing authoritative server-side job reservation and provider-cost reconciliation contracts.
