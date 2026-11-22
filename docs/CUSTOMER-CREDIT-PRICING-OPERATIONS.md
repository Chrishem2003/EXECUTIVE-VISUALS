# Customer credit pricing — operations contract

This document describes the server-owned conversion from provider cost to Executive Visuals customer credits. It is a launch dependency for paid cloud video workflows.

## Required configuration

Set these values in the isolated staging environment first:

| Variable | Requirement | Purpose |
|---|---|---|
| `CUSTOMER_CREDITS_PER_USD` | Required integer, 1–1,000,000 | Platform credit units per USD |
| `CUSTOMER_TARGET_MARGIN_BPS` | Required integer, 1,000–9,000 | Target gross margin in basis points |
| `CUSTOMER_PAYMENT_FEE_BPS` | Optional integer, 0–2,000; default 300 | Percentage payment fee reserve |
| `CUSTOMER_SUPPORT_RESERVE_BPS` | Optional integer, 0–5,000; default 500 | Support / operations reserve |
| `CUSTOMER_FIXED_PAYMENT_FEE_MICROS` | Optional integer, 0–100,000,000; default 0 | Fixed payment fee in USD micro-units |

Legacy `NEON_CUSTOMER_*` names remain accepted by the shared quote-policy factory for the isolated Neon staging workflow. New shared cloud configuration should use the generic `CUSTOMER_*` names.

Do not set these values by copying a guessed provider credit rate. Confirm the intended credit denomination, payment processing contract, settlement currency and target margin first. Store them as server-side secrets/configuration; never expose them to the browser.

## Calculation and boundaries

1. Provider adapter returns a non-billable quote in USD with exact model/operation pricing.
2. The server converts USD to integer micro-units.
3. The shared workload-economics policy applies target margin, payment fee and support reserve.
4. The resulting minimum sale price is converted to integer customer credits, rounded up.
5. The quote persists provider credits and customer credits in separate fields.
6. Approval reserves the customer credit amount atomically with the job and provider budget reservation.
7. Completion reconciles the reservation using authoritative provider usage evidence. Ambiguous outcomes remain pending reconciliation.

Provider credits are never used as customer credits. The client cannot submit a price, margin, credit rate or credit amount that the server trusts.

The current cloud workflow quote path is USD-only. A non-USD provider quote is rejected until a sourced exchange-rate conversion and its version/effective time are implemented.

## Failure behavior

If either required pricing variable is missing or invalid:
- cloud workflow quote creation returns `CUSTOMER_CREDIT_PRICING_UNCONFIGURED` or a pricing error;
- storyboard preflight remains not-ready for approval;
- no paid workflow quote or generation reservation is created.

Do not work around this by falling back to provider credits, zero credits, a hard-coded rate, or unlimited generation.

## Wallet source of truth

The customer-facing `GET /api/billing/credits` endpoint reads the same `billing_credit_ledger` and `billing_credit_reservations` tables used by cloud workflow generation. Legacy loyalty/reward credits are a separate program and must not be presented as the generation wallet.

## Launch checklist

- [ ] Configure pricing in staging and record owner approval of the credit denomination and margin.
- [ ] Run provider-specific quote tests for every enabled model/operation/resolution/audio/reference combination.
- [ ] Verify customer credits exceed provider credits where required by the cost-plus policy.
- [ ] Verify quote → approval → atomic reservation → provider execution → evidence-based settlement.
- [ ] Reconcile staging usage against provider invoices.
- [ ] Review model-level gross margin, failed-job and retry rates.
- [ ] Obtain explicit approval before enabling live billing or paid production execution.

The proposed subscription prices ($9 / $29 / $79 / $199 / custom Enterprise) remain pricing hypotheses. This document does not set monthly credit allowances or activate checkout.
