# Batch 72 — Subscription Plan Credit Economics

**Status:** read-only scenario calculator; private draft plans only  
**Date:** 2026-11-22  
**Scope:** staging-first. No plan activation, included-credit grant, checkout enablement, production migration, paid provider execution or production deployment.

## Purpose

Batch 71 verified the credit-to-revenue attribution ledger. Batch 72 adds a controlled way to test whether the proposed $9 / $29 / $79 / $199 monthly plan hypotheses can support different model-generation workloads before any included-credit allowance is configured.

The calculator deliberately does not choose or persist a final credit allowance. An administrator must supply the credit-budget share as an explicit scenario assumption.

## Admin API

POST /api/admin/finance/subscription-plan-economics

Requires an authenticated owner, platform administrator or billing administrator.

Example request:

```json
{
  "creditBudgetShareBps": 7000,
  "scenarios": [
    {
      "provider": "runway",
      "model": "gen4.5",
      "durationSeconds": 10,
      "resolution": "1080p",
      "audio": false
    },
    {
      "provider": "runway",
      "model": "seedance2_5",
      "durationSeconds": 10,
      "resolution": "1080p",
      "audio": true
    },
    {
      "provider": "runway",
      "model": "kling_4",
      "durationSeconds": 10,
      "resolution": "1080p"
    }
  ]
}
```

The API reads private draft USD monthly plans directly from subscription_plans. It does not accept customer-supplied plan prices or provider rates. Each scenario is priced by the existing server-side estimateVideoGenerationCost contract and then converted through the same configured customer-credit margin, fee and support-reserve policy used by cloud workflow quotes.

Required server configuration:
- CUSTOMER_CREDITS_PER_USD (or the legacy NEON_CUSTOMER_CREDITS_PER_USD)
- CUSTOMER_TARGET_MARGIN_BPS (or the legacy NEON_CUSTOMER_TARGET_MARGIN_BPS)

Optional pricing assumptions retain the existing server-side payment-fee, support-reserve and fixed-fee settings. Missing required settings fail closed; no guessed defaults are used.

## Calculation

For each draft plan:

proposed monthly credits = floor(plan amount in USD × credits per USD × credit-budget share)

For each generation scenario:
1. Estimate provider cost with the dated provider-specific formula.
2. Convert the USD estimate to micro-units.
3. Use the shared customer-credit quote policy to calculate the generation credit charge.
4. Calculate the maximum number of whole generations that fit inside the hypothetical plan allowance.

The result is a comparison aid, not an entitlement recommendation. It assumes that the whole credit allowance is used on one scenario at a time; it does not forecast a mixed-model customer workload.

## Provider price correction

The current Runway Dev pricing page and Kling 4.0 guide were checked on 2026-11-22:
- Kling 4.0 has a documented **20% promotion through November 30, 2026** on 720p and 1080p. The list rates are $0.157/sec and $0.235/sec; promotional rates are $0.1256/sec and $0.188/sec respectively.
- Kling 4.0 4K remains at its $0.549/sec list rate; the current promotion is not applied to 4K.
- For Kling 4.0 requests with input video, the published input rates are $0.094/sec at 720p, $0.141/sec at 1080p and $0.329/sec at 4K. The billed duration is output duration plus the greater of input-video duration and output duration, charged at the input-video rate.
- Kling 4.0 HDR adds $0.047/sec at 1080p and $0.078/sec at 4K. The estimator keeps this as a separate surcharge rather than silently discounting it.
- Seedance 2.5 1080p is $0.68/sec, with its documented minimum and reference-video charges.
- Gen-4.5 is $0.12/sec under the published output-video rate.

The estimator now applies the dated promotion only to the documented HD tiers, preserves 4K list pricing, uses the documented input-video billing formula, includes HDR surcharges, and rejects an explicit request to disable Kling's native audio. When the promotion expires, the date-driven calculation automatically reverts to list price. Temporary discounts are never carried forward without current source evidence.

Official evidence:
- https://dev.runway.com/pricing
- https://dev.runwayml.com/learn/kling-4-0-api
- https://dev.runwayml.com/learn/seedance-2-5-api

## Response semantics and safety

The response includes:
- the explicit credit-budget share and conversion rate;
- provider/model/duration/resolution and dated pricing source;
- estimated provider cost and customer credits per generation;
- hypothetical monthly plan credit allowance;
- maximum whole generations and leftover credits for each model scenario;
- limitations and assumptions.

Every estimate is forecast_not_actual, billable: false and settlementEligible: false.

The API is read-only. It never:
- updates subscription_plans.included_credits;
- activates a plan or makes it public;
- grants, reserves, captures or refunds credits;
- enables checkout or creates a payment;
- submits a generation request or calls a paid provider endpoint.

Plan allowances remain zero until a later reviewed and separately approved entitlement batch.

## Validation

- Pure calculator tests cover margin-policy reuse, scenario coverage, invalid assumptions and plan status gates.
- API tests cover admin authorization, database-sourced draft prices, missing pricing configuration, unsupported models and the absence of writes.
- Runway pricing tests verify current Kling 4.0 list pricing, input-video billing and HDR surcharge.
- Full application, billing and financial integration checks must pass before this draft is promoted.
