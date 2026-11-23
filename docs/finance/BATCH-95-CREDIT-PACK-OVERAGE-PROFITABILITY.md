# Batch 95 — Invoice-backed prepaid credit-pack overage profitability

**Status:** implemented on a draft branch; exact-head CI pending.
**Base:** Batch 76 / PR #811 (feat/model-specific-invoice-cost-evidence-batch-76-2026-11-22).

## Purpose

The mixed subscription workload calculator previously marked workloads above included plan credits as not applicable because prepaid top-up revenue and cost were not modeled. Batch 95 adds a separate, read-only profitability view for the existing server-owned credit-pack catalogue.

## Implementation

- Adds calculateCreditPackOverageEconomics, a pure calculator using the invoice-backed blended provider cost per platform credit from Batch 55/74.
- Reads credit-pack price, currency, credit units and active state from the server-side billing_products catalogue; no product values are accepted from the browser.
- Applies the existing server-owned payment-fee, fixed-fee and support-reserve assumptions.
- Reports provider cost, processing fee, support reserve, contribution and contribution margin only when product currency exactly matches the verified cost-evidence currency.
- Requires complete posted invoice attribution and at least five verified settled jobs before calculating a cost.
- Renders the result in the Financial Command Centre beside the existing subscription, mixed-workload and model-specific actual-cost evidence.

## Important finding: currency blocks a real margin claim

The current provider invoice unit-cost evidence is USD-denominated. The existing credit-pack catalogue is UGX-denominated. The calculator therefore returns blocked_currency_mismatch for those packs and withholds provider cost and contribution instead of inventing an exchange rate.

A verified, approved FX evidence source is required before UGX pack profitability can be calculated against USD provider costs. No FX conversion is performed in this batch.

## Accounting and safety

- This uses historical blended cost per platform credit, not model-specific future cost.
- Payment fees and support reserve use the existing configured assumptions; VAT on gateway fees, refunds, chargebacks, taxes, storage, delivery, acquisition and other overhead remain outside this contribution view.
- Inactive catalogue products remain draft-only; the report does not enable checkout.
- No price, credit amount, plan entitlement, payment, wallet or ledger is changed.
- No product is activated; no customer charge or credit grant is created.
- No database migration, production deployment, merge or new paid infrastructure.

## Verification

- npm run verify:credit-pack-overage-economics
- npm run verify:subscription-plan-economics now includes the new focused test.
- API regression checks verify that UGX products remain blocked against USD invoice evidence.
- UI regression checks verify the Financial Command Centre panel and its draft-only/currency guardrails.
- Full Financial Intelligence, Billing self-service, Neon PostgreSQL integration and Quality Checks are required on the exact PR head before promotion.

## Next decision gate

Do not enable or price UGX credit packs until Finance has a trustworthy, dated FX evidence source and payment-gateway fee/VAT evidence for the actual settlement currency.