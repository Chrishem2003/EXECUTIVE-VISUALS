# Batch 61 — Provider forecast to customer credit quote

**Status:** implementation ready for automated verification.  
**Release state:** review only; no production migration, payment activation, credit grant or generation task is triggered by this quote path.

## What changed

The governed finance estimate endpoint now returns two explicitly separate calculations:

1. **Provider cost forecast** — derived from the exact effective, source-verified rate-card version and the requested output duration, resolution, audio and reference inputs.
2. **Customer credit quote** — converts the USD provider forecast from minor units to exact USD micro-units, then applies the server-owned customer-credit pricing policy and configured credits-per-USD conversion.

The bridge is implemented in `server/provider-customer-credit-quote.mjs`. It rejects non-USD forecasts, actual-invoice records passed as forecasts, unsafe amounts, missing pricing policy and invalid credit outputs.

## Response semantics

When customer credit pricing is configured, the estimate response includes:
- provider, model and exact rate-card version;
- estimated provider cost in USD minor units and micro-units;
- required customer credits;
- configured credit conversion rate;
- credit-equivalent retail value;
- estimated pre-fee contribution margin;
- explicit forecast-only, no-reservation and no-invoice flags.

When customer credit pricing is not configured, the provider forecast remains available to finance administrators, but `customerQuote` is null and `customerQuoteStatus` is `not_configured`. No fallback price or hard-coded credit rate is used.

## Financial and execution boundaries

- Provider credits are not customer credits.
- A forecast is not an invoice, actual usage or guaranteed provider charge.
- Credit-equivalent retail value is not a separate cash charge for credits already included in a subscription.
- Contribution margin is before payment processing, refunds, taxes, support and infrastructure costs.
- The estimate endpoint is finance-admin-only.
- It does not reserve, deduct, grant or transfer customer credits.
- Existing generation approval remains the authoritative atomic reservation gate and must issue a fresh quote before execution.

## Configuration

The bridge uses the existing server-side `NEON_CUSTOMER_CREDITS_PER_USD` and `NEON_CUSTOMER_TARGET_MARGIN_BPS` policy settings, plus the existing optional payment-fee, support-reserve and fixed-fee assumptions. If required settings are absent or invalid, customer quote generation is unavailable rather than silently falling back to a retail price.

## Verification

- Unit tests cover integer USD-cent to micro-dollar conversion, customer credit rounding, margin calculation and fail-closed invalid inputs.
- API tests cover exact rate-card lookup, separate forecast/quote response fields, no reservation and unconfigured policy behavior.
- Existing provider rate-card, video estimator and financial API tests remain in the same CI workflow.
