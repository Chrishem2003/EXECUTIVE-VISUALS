# Batch 83 — Governed provider rate cards in subscription economics

**Status:** implementation branch; CI verification required.  
**Base:** Batch 82 provider-cost-backed credit price floors.

## Problem

The subscription plan economics endpoint previously used only the built-in provider cost estimator. That meant a model priced through the governed, versioned `ai_model_price_catalog` could be estimated separately in the rate-card tool but could not be selected directly in plan affordability scenarios.

## Change

The admin-only `POST /api/admin/finance/subscription-plan-economics` endpoint now supports optional `rateCardVersion` and `currency` scenario fields.

When `rateCardVersion` is supplied, the endpoint:
1. Validates the provider, model, USD currency and version format.
2. Fetches the exact provider/model/currency/version row from the governed rate-card catalogue.
3. Passes the exact row and request shape to `estimateProviderVideoCost`.
4. Converts the resulting USD minor-unit forecast into the plan economics calculator's USD amount.
5. Preserves the rate-card version in each scenario and plan/model coverage row.

The endpoint refuses a missing exact version. It does not silently fall back to another version or to the static estimator. Existing scenarios without `rateCardVersion` retain the previous static provider-estimator behavior.

## Evidence boundary

This remains a read-only hypothetical plan calculation:
- Only private draft USD monthly subscription plans are evaluated.
- No plan allowance, product, credit ledger or entitlement is changed.
- Rate-card estimates are not invoices, actual usage or provider settlement.
- The exact version, source URL, source check timestamp and effective window come from the governed database row.
- The existing shared margin, payment fee, support reserve and credit conversion policy remains the only customer pricing formula.

## Verification

The Batch 83 tests verify:
- Exact lookup by provider, model, currency and version.
- Seedance 2.5 1080p 10-second cost calculation from a 68-cent-per-second governed rate card.
- Preservation of the exact rate-card version in plan and model coverage output.
- Read-only behavior.
- Missing rate-card versions fail rather than silently use another price.

No production rate card is inserted, no subscription is activated, no provider is called, and no production migration or deployment is performed.
