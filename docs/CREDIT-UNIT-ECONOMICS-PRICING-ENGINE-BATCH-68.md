# Batch 68 — Evidence-based credit pricing and subscription allowance engine

## Purpose

Provide a finance-admin-only, non-binding calculator that turns explicitly supplied measured costs and payment-fee assumptions into minimum credit-pack prices and conservative subscription credit ceilings. It does not change customer prices, subscription entitlements, provider routing, or charges.

## Calculation contracts

### Credit pack price floor

Inputs are integer currency minor units and must all use the same ISO currency:
- Provider generation cost.
- Measured/allocated infrastructure cost.
- Expected retry allowance.
- Credit quantity.
- Payment fee basis points and VAT applied to that fee.
- Target contribution margin basis points.
- Optional fixed payment fee.

The floor solves for a customer price after payment processing fees and fee VAT, such that provider + infrastructure + retry costs are covered and the target contribution margin is met. The fee is rounded conservatively upward. The output includes the per-credit minimum and realized margin.

### Subscription credit ceiling

Requires an explicit monthly price, fixed service cost and measured blended variable cost per credit. Returns the maximum allowance consistent with the supplied payment fee and target contribution margin. This is a mathematical ceiling, not a recommended grant; actual allowances should be set below it to preserve safety headroom.

## Evidence and safety

- Missing provider cost is an error; no model rate or provider cost is guessed.
- Currency totals cannot be mixed.
- All values are scenario inputs; no database write, payment, charge or entitlement mutation occurs.
- Payment fee and fee VAT are explicit inputs. VAT on the gateway fee is not a determination of VAT on the platform's sale.
- No tax advice or customer-facing price is produced.
- The API is restricted to owner/platform/billing administrators at `POST /api/admin/finance/credit-pricing/scenario`.
- `mode=credit_pack` calculates a credit-pack floor; `mode=subscription` calculates a maximum monthly credit ceiling.

## Published reference examples (not auto-imported)

Runway Dev's published API guide lists Seedance 2.5 at $0.30/output second for 720p and $0.68/output second for 1080p, with reference-video charges and a minimum generation charge. A five-second output is therefore $1.50 at 720p or $3.40 at 1080p before reference-video costs.

Runway Dev's current Kling 4.0 page lists $0.157/output second at 720p and $0.235/output second at 1080p; Kling 4.0 Flash is $0.094/output second without an input video. Video editing/reference inputs change billed duration. Prices are volatile and must be rechecked before creating a rate card.

Sources:
- https://docs.dev.runwayml.com/guides/pricing/
- https://dev.runway.com/learn/seedance-2-5-api
- https://dev.runway.com/learn/kling-4-0-api

These examples are USD provider costs, not customer credit prices. No price-card rows are seeded automatically.

## Validation

Node tests cover cost completeness, currency and margin bounds, fee/VAT handling, plan credit ceilings, admin authorization and non-binding behavior. The billing self-service workflow runs the tests alongside existing rate-card, metering, PostgreSQL and Batch 65–67 checks.

## Rollout boundary

Draft branch only. No production migration, customer charge, subscription allowance change, live provider call, deploy or new paid infrastructure.
