# Batch 100 — GPT Image 2.6 format-specific cost completeness

**Status:** draft implementation; exact-head CI verification required.
**Base:** Batch 99 / PR #836.

## Objective

Extend the Runway Dev GPT Image 2.6 estimator beyond still-image PNG/JPEG/WebP requests. GIF and SVG have materially different pricing and input restrictions and must not be quoted using the still-image formula.

## Verified provider contract

Checked 23 November 2026 against the official Runway Dev pricing guide and GPT Image 2.6 input documentation.

Runway Dev credits are USD $0.01 each. GPT Image 2.6 Flare and Sunburst share the same price schedule.

### PNG, JPEG and WebP
- Still-image rates are the model's published size/quality/aspect-ratio table.
- Each reference image adds one credit per generated image.
- `outputCount` is 1–10.
- Minimum charge is 2 credits per image.
- `ratio: "auto"` reserves 9, 16 or 19 credits per output for low, medium or high quality; final settlement follows the rendered size tier.
- `reasoningEffort` does not change price.
- JPEG cannot use a transparent background.

### GIF
- Price is per animation, multiplied by `outputCount`.
- 2–8 frames: low 2, medium 4, high 4 credits.
- 9–12 frames: low 4, medium 7, high 8 credits.
- 13–16 frames: low 6, medium 10, high 12 credits.
- Default frame count is 9; valid frame count is 2–16.
- `ratio` must be `auto`.
- GIF does not accept reference images.
- Frame duration does not affect the price.

### SVG
- Uses the equivalent PNG still-image rate plus a 50-credit authoring charge per output.
- `outputCount` multiplies both the image component and the authoring charge.
- SVG does not accept reference images.
- For `ratio: "auto"`, the still-image component follows the normal reservation/settlement behavior; the authoring charge remains fixed.

## Implementation

Updated `server/runway-image-pricing.mjs` to:
- Accept output formats `png`, `jpeg`, `webp`, `gif`, and `svg`.
- Calculate GIF costs using frame-count bands and output count.
- Calculate SVG costs as image price plus 50 authoring credits per output.
- Reject GIF/SVG references and invalid GIF ratio/frame combinations.
- Reject transparent JPEG requests.
- Keep all outputs forecast-only (`billable: false`, `settlementEligible: false`).

Regression tests cover the GIF frame bands, output multiplication, SVG authoring charges, and invalid format/input combinations.

## Verification

Run `npm run verify:runway-image-pricing`.

## Remaining limits

- No task receipt/actual-cost reconciliation is added in this batch.
- Auto-resolution and GIF/SVG still require task-level realized usage reconciliation before final settlement.
- Storage, delivery, payment fees, taxes, retries, refunds and support costs remain separate cost dimensions.
- This does not convert Runway provider credits into Executive Visuals customer credits.

## Evidence

- Runway Dev API Pricing & Costs: https://docs.dev.runwayml.com/guides/pricing/#gpt-image-2-6-flare-and-sunburst
- Runway Dev API Input Parameters: https://docs.dev.runwayml.com/assets/inputs/#gpt-image-2-6-inputs
- Runway Dev changelog (GPT Image 2.6 availability and request limits): https://docs.dev.runwayml.com/changelog/

## Release boundaries

- No provider API calls or credentials.
- No live rate-card activation or mutation.
- No customer credit conversion, plan allowance, checkout or subscription changes.
- No database migrations, merge, production deployment or new paid infrastructure.
