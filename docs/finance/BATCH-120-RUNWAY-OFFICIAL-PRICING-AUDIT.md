# Batch 120 — Official Runway price audit and regression lock

**Pricing snapshot date:** 2026-11-25  
**Scope:** Runway Dev API list prices only. This is not a customer price list, provider quote, invoice, or settlement record.

## Primary official sources
- Seedance 2.5 API pricing and input-reference billing: https://dev.runwayml.com/learn/seedance-2-5-api
- Kling 3.0 API pricing, audio behavior and billing: https://dev.runwayml.com/learn/kling-3-0-api
- WAN 3.0 and WAN 3.0 Prime API pricing: https://dev.runwayml.com/learn/wan-3-0-api
- Runway Dev API pricing guide: https://docs.dev.runwayml.com/guides/pricing/

The official documentation states one Runway Dev credit equals USD $0.01. Prices below are provider list-price estimates before any customer credit markup, taxes, payment fees, infrastructure costs, retry allowance or other platform costs.

## Regression-locked rates

| Model / setting | Provider rate | Five-second output-only cost |
|---|---:|---:|
| Seedance 2.5 1080p | 68 credits/sec | 340 credits / $3.40 |
| Seedance 2.5 4K | 110 credits/sec | 550 credits / $5.50 |
| Kling 3.0 Standard, silent | 9 credits/sec | 45 credits / $0.45 |
| Kling 3.0 Standard, audio | 13 credits/sec | 65 credits / $0.65 |
| WAN 3.0 480p | 5 credits/sec | 25 credits / $0.25 |
| WAN 3.0 720p | 10 credits/sec | 50 credits / $0.50 |
| WAN 3.0 1080p | 20 credits/sec | 100 credits / $1.00 |
| WAN 3.0 Prime 1080p | 28 credits/sec | 140 credits / $1.40 |

Seedance 2.5 video references add 34 credits per input-video second at 1080p and 57 credits per input-video second at 4K. The documented 80-credit minimum and input/reference-video combined billing cap remain implemented in the existing estimator.

## Implementation
- Adds a dedicated regression test file against the existing `estimateRunwayVideoCredits` implementation.
- Tests audio on/off as separate Kling Standard prices.
- Tests the Seedance 2.5 reference-video surcharge.
- Tests WAN resolution tiers and keeps WAN Prime distinct.
- No production pricing rows or active provider configuration are modified by this PR.

## Commercial boundary
These are provider costs, not customer selling prices. A customer-facing quote still needs the current approved rate card, currency conversion evidence where applicable, fully loaded variable cost, payment processing, taxes, retry/refund reserve, support cost and the configured minimum margin. A stale or missing rate card must continue to block dispatch.

## Verification
```sh
node --test server/tests/runway-official-pricing-audit.test.mjs
```
