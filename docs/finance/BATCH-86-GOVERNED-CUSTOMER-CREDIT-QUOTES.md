# Batch 86 — Governed provider forecast to customer-credit quote

**Status:** draft implementation stacked on Batch 85 (#820).  
**Purpose:** make provider cost and customer-credit price available as separate, traceable values from the same exact governed rate-card version.

## Change

- Adds a pure quote bridge from positive USD provider-cost forecasts to customer credits.
- Uses the existing server-owned customer credit pricing policy (target margin, payment fee and support reserve) and explicit credits-per-USD conversion.
- Extends the finance-admin model rate-card estimate response with `customerQuote` and `customerQuoteStatus`.
- Keeps provider estimate and customer-credit quote distinct; provider credits are never interpreted as customer credits.
- Preserves exact rate-card version, cost micro-units, credit-equivalent retail value and estimated pre-fee contribution margin.
- If the customer-credit policy is not configured, the provider forecast remains available and the quote is `null`; no fallback conversion or retail price is invented.

## HDR parity

The route uses the shared provider estimator, including Batch 84's explicit HDR surcharge and Batch 85's strict boolean validation. Regression coverage verifies a 10-second 1080p scenario with a $2.40 base rate plus $0.50 conservative HDR surcharge yields a $2.90 provider forecast before the customer-credit pricing policy is applied.

## Boundaries

- Quote is a forecast, not an invoice or guaranteed provider charge.
- The endpoint remains finance-admin-only.
- It does not reserve, deduct, grant or transfer customer credits.
- It does not submit a provider task or create a generation job.
- A fresh quote and the existing atomic generation approval remain required before execution.
- No plan/credit allowance is activated, no payment product is created, no migration is applied and no deployment occurs.

## Verification

Unit tests cover integer micro-unit conversion, margin policy, invalid quote inputs and bounds. API tests cover admin authorization, exact rate-card version lookup, HDR cost inclusion, customer-credit conversion, no reservation, and fail-closed unconfigured pricing.
