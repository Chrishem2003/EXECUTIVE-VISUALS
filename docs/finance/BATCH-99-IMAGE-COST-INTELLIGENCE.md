# Batch 99 — GPT Image 2.6 cost intelligence

**Status:** draft implementation; exact-head CI verification required.
**Base:** Batch 98 / PR #835 (`feat/generation-cost-completeness-batch-98-2026-11-23`).

## Objective

Bring the image-generation estimator into line with the current Runway Dev GPT Image 2.6 price sheet, so image and video generation can be quoted using versioned provider-specific assumptions.

## Verified provider pricing

Checked 23 November 2026 against the official Runway Dev API pricing guide, section “GPT Image 2.6 Flare and Sunburst”. Runway Dev provider credits are USD $0.01 each.

The model uses the same shape/size grid as GPT Image 2.5, but the GPT Image 2.6 quality rates are different. The exact 1K, 2K and 4K rate matrix is now represented in `server/runway-image-pricing.mjs`.

| Size | Landscape low | Landscape medium | Landscape high |
|---|---:|---:|---:|
| 1K | 2 credits | 4 credits | 5 credits |
| 2K | 3 credits | 5 credits | 6 credits |
| 4K | 5 credits | 9 credits | 11 credits |

Square and other aspect ratios use their own documented table entries. Every returned image has a minimum charge of 2 credits. Each reference image adds 1 credit per generated image. `outputCount` is 1–10.

Flare and Sunburst have the same pricing. Reasoning effort and background choice do not change the PNG/JPEG/WebP image rate.

For `ratio: "auto"`, the request reserves the highest square 4K price up front: 9 credits at low quality, 16 at medium, and 19 at high. Actual settlement depends on the rendered size tier. The current estimator reports this as an upfront reservation estimate; it does not claim to settle a completed task.

## Implementation changes

- Replace the legacy 2.5-style matrix with the documented GPT Image 2.6 1K/2K/4K matrix.
- Preserve all 30 documented pixel size values and resolve them to the correct shape category.
- Enforce per-image reference charges multiplied by `outputCount`.
- Enforce the 2-credit minimum per returned image via the verified rate matrix.
- Advertise the documented output count maximum of 10 in model metadata, matching estimator validation.
- Keep estimates explicitly non-billable and not eligible for settlement.
- Keep GIF and SVG out of this PNG/JPEG/WebP estimator; they have separate frame-count and authoring charges and must be implemented as distinct billing modes before quoting.

## Regression coverage

The new `server/tests/runway-image-pricing.test.mjs` suite covers:
- 2K medium landscape with references and multiple outputs.
- Minimum low-cost 1K ultra-wide image.
- Per-reference-per-output multiplication.
- Auto resolution reservation at square 4K pricing.
- Maximum output count of ten and catalogue metadata consistency.
- Equal Flare/Sunburst pricing.
- Invalid model, quantity, reference count and missing evidence date.

Run locally/CI with `npm run verify:runway-image-pricing`.

## Commercial interpretation

A model-specific image estimate is not an Executive Visuals customer credit price. Runway provider credits, Executive Visuals customer credits and USD remain separate units.

Before customer billing, the platform still needs:
- Task-level actual usage or invoice evidence.
- Auto-resolution reservation-to-settlement adjustment.
- Failed-task and moderation charge semantics.
- GIF frame-count and SVG authoring cost support.
- Storage, delivery, payment, tax and operational cost allocation.

## Evidence

- Official Runway Dev API pricing guide: https://docs.dev.runwayml.com/guides/pricing/#gpt-image-2-6-flare-and-sunburst
- Official GPT Image 2.6 API overview and price explanation: https://dev.runway.com/learn/gpt-image-2-6-api

## Release boundaries

- No provider API call or key usage.
- No rate-card activation or live rate-card mutation.
- No customer credit conversion, plan allowance, checkout or subscription change.
- No production/staging migration, merge or deployment.
- No new paid infrastructure or provider spend.
