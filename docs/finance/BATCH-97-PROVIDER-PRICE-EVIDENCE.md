# Batch 97 — Provider price evidence and generation-cost scenarios

**Status:** draft implementation; exact-head verification required.
**Base:** Batch 96 / PR #833 (`feat/approved-fx-evidence-batch-96-2026-11-23`).

## Purpose

Make published provider costs concrete enough to test the existing immutable rate-card estimator, without confusing a public price page with an executed provider contract, invoice, or actual generation cost.

This batch adds regression coverage for Runway Dev's published Seedance 2.5 billing dimensions. It does not seed a production rate card, make a provider call, change customer credit pricing, or enable generation.

## Published Runway Dev API rates checked 23 November 2026

Runway Dev documents Seedance 2.5 as follows. One Runway credit is USD $0.01.

| Output | Output rate | Reference-video rate | Five-second output |
|---|---:|---:|---:|
| 480p | $0.20/sec | $0.10/sec | $1.00 |
| 720p | $0.30/sec | $0.15/sec | $1.50 |
| 1080p | $0.68/sec | $0.34/sec | $3.40 |

Additional documented conditions:
- Minimum generation charge: $0.80.
- Video references are charged separately per second at the selected output resolution.
- Image and audio references add no charge on this Runway route.
- Automatic duration is billed as 30 seconds up front, with unused duration refunded after completion.
- Moderation input failures may still incur a charge.
- Draft mode can incur separate preview and enhanced-generation charges.

These are Runway Dev channel prices, not a claim about direct ByteDance enterprise pricing or a negotiated Executive Visuals rate.

## Alternative models on the same Runway Dev route

The current Runway pricing guide also lists:
- Kling 3.0 Standard: $0.09/sec without audio; $0.13/sec with audio.
- Kling 3.0 Pro: $0.12/sec without audio; $0.17/sec with audio.
- Kling O3 Standard: $0.13/sec.
- Kling O3 Pro: $0.17/sec.
- Kling 4.0 4K: $0.43/sec.

The Kling 4.0 720p and 1080p rows were subject to a stated 20% promotion through 30 November 2026 UTC. Do not store the promotional rate as a permanent list price; the version must include its effective window and be replaced when the promotion expires.

## Image generation reference

Runway Dev's GPT Image 2.6 page lists a 2K Medium output at $0.05 and 4K Medium output at $0.09, with other quality/size combinations and reference-image surcharges. Image generation is not included in the Seedance video-cost test because it has a separate billing unit and needs a dedicated image-cost scenario before any customer credit quote is published.

## What the code now verifies

The provider video estimator regression suite now checks:
- Five-second Seedance 2.5 outputs at 480p, 720p and 1080p.
- Resolution-specific reference-video surcharges.
- The $0.80 minimum generation charge.
- Explicitly itemized forecast cost lines.

The tests use USD cents as integer minor units. They validate the existing estimator contract; they do not insert these values into the live or staging rate-card catalogue.

## Commercial interpretation

The $9 / $29 / $79 / $199 monthly plans cannot be treated as including arbitrary premium video minutes.

For example, a single five-second 1080p Seedance 2.5 output on the Runway Dev route has a published provider cost of $3.40 before payment processing, support, storage, render compute, delivery, retries, refunds, taxes and acquisition. Three such outputs would cost $10.20 in provider fees alone, exceeding the proposed $9 Starter subscription before any other cost.

That is why the product should:
1. Include a conservative monthly allowance of low-cost activities and planning tools.
2. Charge premium generation from an itemized quote based on the selected model, resolution, duration and reference inputs.
3. Reserve customer credits before a job is submitted, settle against actual provider cost when known, and release unused reservation after verified completion.
4. Apply provider-specific failure/refund rules rather than assuming every failed request is free.
5. Recalculate the credit quote whenever the rate-card version or provider route changes.

Do not infer a universal credit-to-USD exchange rate from provider credits. Provider credits, Executive Visuals customer credits and money are three separate units.

## Evidence sources

Checked 23 November 2026:
- Runway Dev Seedance 2.5 API pricing: https://dev.runway.com/learn/seedance-2-5-api
- Runway Dev API pricing guide: https://docs.dev.runway.com/guides/pricing/
- Runway Dev usage/model catalogue: https://dev.runway.com/usage
- ByteDance Seedance official enterprise API pricing: https://seed.bytedance.com/en/seedance-enterprise/api
- Kling API documentation and package-based billing guidance: https://kling.ai/document-api/guides/get-started/quick-start

## Release boundaries

- No provider API call or key usage.
- No automatic rate-card import or rate-card seeding.
- No live or staging database migration.
- No subscription prices, plan allowances, customer credit rates, checkout, ledger, or entitlement changes.
- No production deployment, merge, or new paid infrastructure.
- Rate-card activation remains a finance-admin action requiring a current source check and explicit approval.
