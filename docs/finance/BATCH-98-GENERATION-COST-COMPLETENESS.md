# Batch 98 — Generation cost completeness

**Status:** draft implementation; exact-head CI verification required.
**Base:** Batch 97 / PR #834 (`feat/provider-cost-price-evidence-batch-97-2026-11-23`).

## Objective

Make the model-specific video forecast account for the full published Seedance 2.5 billing formula before the platform quotes customer credits. This remains a forecast, not a provider quote, invoice or actual job cost.

## Verified Runway Dev Seedance 2.5 price sheet

Checked 23 November 2026 against the Runway Dev model page and pricing guide.

| Resolution | Output USD / second | Combined input + reference video USD / second | Five-second output |
|---|---:|---:|---:|
| 480p | $0.20 | $0.10 | $1.00 |
| 720p | $0.30 | $0.15 | $1.50 |
| 1080p | $0.68 | $0.34 | $3.40 |
| 4K | $1.10 | $0.57 | $5.50 |

Minimum generation charge: $0.80.

Billing details:
- Input video and reference video are billed together by combined duration, capped at 30 seconds.
- A reference video from 2 seconds to less than 4 seconds is padded to 4.25 seconds for billing.
- Image and audio references are free on this model route.
- Automatic duration is billed as 30 seconds initially, with unused duration refunded after completion.
- Draft preview and enhanced generation are two separately billed generations.
- Input moderation failures can still be charged; do not assume a failed task is free.

The source's current model page also documents 4K pricing and its input/reference rate. The estimator now supports the 4K resolution key and explicit combined input/reference duration mode.

## Code changes

The existing immutable provider video estimator now supports:
- A combined input/reference video billing mode.
- Explicit combined duration caps.
- Reference-duration padding thresholds and padded duration.
- Resolution-specific 4K rates and input/reference rates.
- One itemized combined-input cost line rather than accidentally double-counting the same source video as both input and reference.
- Fail-closed behavior when the combined input/reference rate is missing or the combined duration exceeds the configured cap.

Regression tests cover:
- 4K five-second output at $5.50.
- 1080p five-second output plus three seconds of input and a 2.5-second reference: 7.25 billed input/reference seconds × $0.34 = $2.47, plus $3.40 output = $5.87.
- The 30-second combined cap.
- Padding boundaries below 2 seconds, at 2 seconds, below 4 seconds and at 4 seconds.

## Important limits still to implement

This batch does not yet claim complete cost coverage for:
- Automatic duration's initial reservation and post-completion refund.
- Separate draft-preview and enhancement task lifecycle.
- Actual provider task usage/cost reconciliation.
- Image model cost estimation and reference-image/output-count dimensions.
- Storage, egress, retries, delivery, payment fees, taxes, chargebacks or support overhead.

These must remain separate evidence dimensions and must not be hidden inside an average per-second number.

## Image API evidence for next increment

Runway Dev's GPT Image 2.6 pricing page (checked 22 November 2026) documents:
- Low quality: $0.02 / $0.03 / $0.05 for 1K / 2K / 4K landscape.
- Medium: $0.04 / $0.05 / $0.09.
- High: $0.05 / $0.06 / $0.11.
- Each reference image adds $0.01 per generated image.
- Minimum charge: $0.02 per generation.
- Output count multiplies image charges; shape-specific prices apply, with square the highest.
- Auto resolution uses the highest square 4K rate.
- Moderation failures can still be charged.

No customer credit conversion is inferred from provider credits. Runway provider credits are a separate unit from Executive Visuals customer credits.

## Evidence sources

- Runway Dev Seedance 2.5 API pricing: https://dev.runway.com/learn/seedance-2-5-api
- Runway Dev API pricing guide: https://docs.dev.runway.com/guides/pricing/
- Runway Dev GPT Image 2.6 API pricing: https://dev.runway.com/learn/gpt-image-2-6-api

## Release boundaries

- No API calls, provider keys or paid generation.
- No automatic rate-card seeding or live rate-card activation.
- No customer credit price, plan allowance, checkout or entitlement changes.
- No production or staging migrations.
- No merge, deployment, infrastructure spend or provider spend.
- Existing production services and billing configuration remain untouched.
