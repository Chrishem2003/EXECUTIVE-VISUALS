# Batch 84 — Governed HDR provider-cost calculation

**Status:** implementation branch; exact-head CI verification required.  
**Base:** Batch 83 governed provider rate cards in subscription plan economics.

## Problem

The governed provider estimator already prices output resolution, reference footage, audio, input video, images and minimum generation charges. It did not model the separately billed HDR surcharge. A plan affordability scenario could therefore understate a premium Kling 4.0 request when HDR was enabled.

## Change

- Adds explicit hdrSurchargeSecondMinor and resolution-specific hdrSurchargeSecondMinor_<resolution> dimensions to the governed rate-card schema allowlist.
- Passes the server-validated hdr scenario flag into the provider-cost estimator.
- Adds a separate hdr_output_seconds cost line, preserving the base output rate and surcharge independently.
- Requires an exact HDR surcharge when HDR is requested. Missing pricing fails closed; it never silently assumes HDR is free.
- Preserves the exact governed rate-card version and read-only forecast boundary.

## Verified example

Runway Dev's Kling 4.0 API pricing guide, checked November 22, 2026, lists:
- 1080p output: USD 0.235 per second.
- 1080p HDR surcharge: USD 0.047 per output second.
- 4K output: USD 0.549 per second.
- 4K HDR surcharge: USD 0.078 per output second.

The rate-card estimator stores rates in integer currency minor units. To avoid undercharging when a provider publishes fractional-cent per-second rates, each rate is rounded upward independently: USD 0.235 becomes USD 0.24 per second and USD 0.047 becomes USD 0.05 per second. A 10-second 1080p HDR scenario therefore conservatively forecasts USD 2.90 (USD 2.40 output + USD 0.50 HDR), rather than understating the exact USD 2.82 arithmetic. This conservative rounding is before input-video billing, taxes, retries, infrastructure or support allocation.

Source: https://dev.runwayml.com/learn/kling-4-0-api

## Verification

The API regression tests cover exact provider/model/currency/version rate-card lookup, inclusion of the 1080p HDR surcharge in the plan economics forecast, preservation of the exact rate-card version, read-only behavior, and fail-closed behavior when HDR is requested but the exact rate card lacks an HDR surcharge.

No rate card, plan, credit allowance, payment product, customer ledger or entitlement is activated. No provider is called, no production migration is applied and no deployment is performed.
