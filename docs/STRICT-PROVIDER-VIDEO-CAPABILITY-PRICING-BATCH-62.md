# Batch 62 — Strict provider video capability pricing

**Status:** implementation committed; automated verification pending.  
**Scope:** prevent a provider cost forecast from treating a resolution as supported when the effective rate card explicitly excludes it or does not attest it.

## Change

The provider video estimator now recognizes numeric-only `resolutionSupported_<tier>` capability flags in the existing immutable rate-card `pricingDimensions` object.

Examples:
- `resolutionSupported_720p: 1` — provider attests the 720p tier.
- `resolutionSupported_1080p: 0` — provider explicitly does not offer that tier.
- Omitted tier in an explicit capability matrix — not attested and therefore rejected.

When at least one resolution capability flag is present, the matrix is treated as authoritative: the requested tier must be explicitly set to numeric `1`. Invalid flag values fail closed. Existing historical rate cards without a capability matrix retain prior behavior until replaced by a new evidence-backed version.

## Why this matters

A per-second price alone does not prove a model supports every resolution. Treating an unsupported resolution as if it inherited a base rate can understate the cost, route a job to an invalid provider configuration, or show a customer a misleading quote.

This batch adds a strict capability boundary without inventing or seeding model prices. Finance administrators must still register the exact provider/model/version, effective dates, source evidence, output rates and capability matrix through the existing immutable rate-card workflow.

## Verification

- Tests cover supported tiers, explicitly unsupported tiers, omitted tiers in a declared matrix, invalid capability values, and legacy rate-card compatibility.
- Existing tests continue to cover resolution-specific rates, audio inclusion/surcharges, input/reference video pricing, minimum generation charges, evidence freshness and safe integer arithmetic.

## Safety

- No provider API calls or generation jobs.
- No customer quote, reservation, deduction or credit grant.
- No new pricing values or provider capabilities are assumed.
- No schema migration, production configuration, merge or deployment.
