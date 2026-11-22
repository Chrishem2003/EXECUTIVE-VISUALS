# Batch 82 — Provider-cost-backed video credit price floors

**Status:** pricing evidence and automated scenario validation; not a public price catalogue.  
**Base:** Batch 81 administrator credit adjustments.

## Verified provider cost examples

The following examples use Runway Dev's published API rates and a 10-second text-to-video output at 1080p:

| Model | Published API rate | Direct provider cost |
|---|---:|---:|
| Seedance 2.5 | $0.68/second | $6.80 |
| Kling 4.0 | $0.235/second | $2.35 |

These are provider API costs, not customer prices. The source comparison is dated November 9, 2026. The official Seedance 2.5 rate guide also documents resolution-specific billing and minimum charges.

## Pricing policy used for the scenarios

Use the existing shared `priceWorkloadCostUnits` engine; do not create a second pricing formula.

- Target contribution margin: 60% (6,000 basis points)
- Support reserve: 5% of provider cost (500 basis points)
- Payment fee scenario A: 3% (Uganda mobile-money collection)
- Payment fee scenario B: 4.8% (local or international card collection)
- Fixed fee: zero for this illustration
- Currency: USD micro-units internally; round customer-facing prices upward to cents

Formula:

`minimum price = ceil((provider cost + support reserve + fixed fee) / (1 - target margin - payment fee))`

The Flutterwave Uganda pricing page currently lists 3% for local wallets/mobile money and 4.8% for local and international cards. The 3% scenario is not a safe universal assumption; actual payment mix and merchant settlement reports must determine the production fee configuration.

## Minimum selling-price scenarios

| 10-second 1080p generation | 3% payment fee | 4.8% payment fee |
|---|---:|---:|
| Seedance 2.5 | $19.30 | $20.29 |
| Kling 4.0 | $6.67 | $7.01 |

A 5-second Seedance 2.5 1080p output costs $3.40 directly and has a calculated floor of approximately $9.65 under the 3% scenario. This alone is enough to show why a $9 Starter subscription cannot promise a premium 5-second Seedance generation with the stated margin and reserve.

## Credit conversion

The current quote policy converts the minimum sale price to credits using the configured `CUSTOMER_CREDITS_PER_USD` / `NEON_CUSTOMER_CREDITS_PER_USD` rate. This batch does not choose that conversion rate or publish credit packs.

For regression testing only, 100 credits per USD is used as an explicitly hypothetical example. Under that assumption, the 10-second Seedance 2.5 example requires 1,930 credits at a 3% payment-fee assumption, or 2,029 credits at 4.8%. These are not approved commercial prices.

## What remains excluded

These floors do not yet include taxes, storage, rendering, transcoding, infrastructure, chargebacks, refunds, moderation charges, retry rates, failed-job costs or volume discounts. Premium model allowances must remain capped until these costs are measured and reconciled against provider invoices.

## Launch gate

Before subscription allowances or top-up packs are activated:
1. Verify the exact provider/model/resolution rate cards with a dated source or provider contract.
2. Configure the actual payment fee mix, not a generic optimistic percentage.
3. Reconcile estimated generation cost to invoices and successful/failed job telemetry.
4. Add storage, render, tax, refund and retry reserves.
5. Recalculate plan-level credit allowances with the existing subscription economics endpoint.
6. Obtain finance approval and then activate products in a separate, explicitly reviewed change.

No customer-facing credit allowance, rate card, plan price, product activation, provider call, payment, production migration or deployment is created by this batch.
