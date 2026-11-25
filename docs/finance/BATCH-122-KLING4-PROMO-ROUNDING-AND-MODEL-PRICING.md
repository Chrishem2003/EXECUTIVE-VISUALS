# Batch 122 — Kling 4.0 promotional rounding and model-price regression

**Pricing snapshot:** 2026-11-25 UTC  
**Primary source:** https://docs.dev.runwayml.com/guides/pricing/  
**Model source:** https://dev.runwayml.com/learn/kling-4-0-api

## Finding
The existing Kling 4.0 promotional estimator discounted the fractional list charge before rounding. Runway's pricing guide specifies that the list-price charge is rounded up to the next credit first, then the 20% promotion is applied and rounded up again. The previous order could understate the payable provider credits.

## Correction
For promotional 720p and 1080p output:
1. Compute the full list-price charge, including applicable input-video billing.
2. Round that list charge up to the next whole credit.
3. Apply the 20% promotion through 2026-11-30 UTC.
4. Round the discounted charge up again.
5. Keep 4K outside the promotion. From 2026-12-01 UTC, use undiscounted list prices.

Regression examples for five-second output-only clips:
- Kling 4.0 720p during promotion: 64 credits.
- Kling 4.0 1080p during promotion: 95 credits.
- Kling 4.0 1080p from 2026-12-01: 118 credits.
- Kling 4.0 4K during promotion: 275 credits (no discount).

## Model coverage extended
- Gemini Omni Flash 1.2: 5 seconds at 720p = 35 credits; at 1080p = 50 credits.
- Kling 4.0 Flash: 5 seconds at 720p = 47 credits.

These are provider estimates only, not customer selling prices or a fully-loaded margin quote. They exclude customer-credit markup, payment processing, tax, storage, egress, retries, refund reserve and support.

## Safety
No live provider rate-card rows, customer prices, wallet balances, payment records, provider credentials or production configuration are modified. No provider execution, migration or production deployment.
