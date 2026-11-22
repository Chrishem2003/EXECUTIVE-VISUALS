# Batch 41 — Model-specific provider video cost estimates

**Status:** implemented on a draft branch; verification pending.  
**Scope:** internal admin-only forecast from exact persisted rate-card versions. No provider execution, customer charge, ledger write, production migration or deployment.

## Delivered

- `server/provider-video-cost-estimator.mjs` computes output-video, reference-video, input-video, input-image, optional audio and minimum-generation costs using integer currency minor units.
- Resolution-specific output, reference and input-video rates can be stored as numeric `pricingDimensions` fields such as `videoSecondMinor_720p`.
- Input-video duration billing is explicit: `inputVideoBillingMode=0` bills input duration; `1` bills the greater of input and output duration.
- Audio must be explicitly marked `audioIncluded=1` or have an `audioSurchargeSecondMinor` rate. Missing audio treatment fails closed.
- Minimum generation cost is represented by `minimumGenerationMinor`.
- The estimator rejects unsupported dimension keys, stale/future/legacy-unverified cards, missing requested input prices, unsupported resolutions and unsafe quantities.
- `POST /api/admin/finance/model-rate-card-estimates` is restricted to owner/platform/billing administrators. It retrieves the exact provider/model/currency/version from the existing `ai_model_price_catalog` table; caller-supplied prices are ignored.
- The Financial Command Centre has a model-specific video cost calculator UI that displays the forecast, exact rate-card version, evidence status, source and itemized cost lines.

## Formula

`provider_cost = output_seconds × resolution_output_rate + reference_video_seconds × reference_rate + input_video_billable_seconds × input_video_rate + input_images × input_image_rate + audio_surcharge + minimum_adjustment`

The input-video billable duration is selected only by the saved rate card's explicit numeric billing-mode dimension. Every requested input type must have a matching price or explicit inclusion rule.

All per-line currency calculations round upward to the next minor unit. The minimum generation amount applies to the subtotal; it is not added on top.

## Evidence and safety

- A forecast is not a provider quote, invoice or actual usage.
- Source-linked rates require an HTTPS source and check timestamp; contract/admin attestation requires matching verification status.
- The estimator reads the saved rate-card record and checks its effective period at calculation time.
- No browser-supplied rate is authoritative.
- No default vendor price is seeded automatically. A finance administrator must review and append a versioned rate card with evidence.
- Provider actual-cost settlement remains based on task-correlated usage receipts and invoice reconciliation, never this forecast.
- Customer credits remain a separate platform-defined unit and are not returned by this endpoint.
- The endpoint does not call a provider or mutate a financial ledger.

## API request

```json
{
  "provider": "runway",
  "model": "seedance-2.5",
  "currency": "USD",
  "rateCardVersion": "2026-11-v1",
  "request": {
    "outputSeconds": 5,
    "resolution": "1080p",
    "referenceVideoSeconds": 2,
    "inputVideoSeconds": 0,
    "inputImageCount": 0,
    "hasAudio": false
  }
}
```

## Verification

Added unit and API tests for exact rate-card lookup, authorization, version binding, provider-price tampering resistance, reference-video pricing, resolution overrides, audio pricing, input-video duration modes, input images, minimum charges, rounding, stale/legacy rate cards and missing dimensions.

CI must pass on the exact PR head before this batch is considered verified. This branch is stacked on PR #760 and remains draft.
