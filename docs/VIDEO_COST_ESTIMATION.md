# Video generation cost estimates

Executive Visuals exposes a read-only estimate endpoint for generation workflows. It does not submit provider jobs, reserve credits, or charge an account.

## Configuration

Set `VIDEO_MODEL_PRICING_JSON` on the API service to a JSON array of explicitly sourced pricing records. Each record must contain:

- `provider` and exact `model` identifiers.
- ISO 4217 `currency`.
- HTTPS `sourceUrl`, `observedAt`, and `expiresAt` timestamps.
- `ratesPerSecond`, keyed by supported resolution (`provider_default`, `480p`, `720p`, `1080p`, `1440p`, `2160p`, `1k`, `2k`, or `4k`).
- Optional `minimumCharge`, `audioSurchargePerSecond`, `referenceImageFee`, and `billingIncrementSeconds`.

Pricing records are rejected if malformed, duplicated for the same provider/model, missing source attribution, or using a non-HTTPS source. Estimates are unavailable when the record is expired, not yet valid, or does not cover the requested resolution. The estimator never substitutes a different model or guesses a price. Keep the JSON configuration current and review provider terms before enabling remote execution.

## Endpoint

Authenticated callers may request:

`POST /api/video-cost-estimate`

Example request:

```json
{
  "provider": "fal",
  "model": "fal-ai/example-video",
  "durationSeconds": 8,
  "resolution": "720p",
  "audioMode": "generated",
  "referenceImageCount": 1
}
```

The response includes the estimated amount, currency, billable duration, itemized video/audio/reference breakdown, and the pricing source and validity window. If the exact model has no current schedule, the response is `available: false` with a reason.

The endpoint is authenticated, rate-limited, and performs no external network request. It does not claim to include taxes, account discounts, provider moderation charges, retries, or price changes. The final provider invoice remains authoritative.

## Safety

- No provider API key is needed to estimate.
- No provider call, job submission, storage write, or credit reservation occurs.
- No default or example price is shipped as a live price.
- The provider catalog exposes only model identifiers and pricing provenance, not credentials.
- Remote generation remains independently disabled unless the existing server-side opt-in is enabled.

## Multi-shot production quote

Authenticated callers may request a read-only quote for a production containing 1–12 shots:

`POST /api/video-production-quote`

Each shot supplies a unique `id` and the same exact provider/model/resolution/audio/reference fields accepted by the single-generation estimator. Each shot is priced independently using its own billing increment and minimum charge. The combined duration is capped at 180 seconds. The API returns shot-level estimates and an itemized production total.

A total is unavailable if any shot lacks a current verified rate, if the shot IDs are invalid or duplicated, if the plan exceeds the shot or duration limits, or if currencies differ. Currency conversion is never inferred. Provider batch discounts are not assumed.

This endpoint is a budgeting aid only. It does not submit, queue, reserve, or charge for any generation.

## Workflow canvas preflight

In the Workflow workspace, select a **Video Generation** node and configure its JSON with the exact `provider`, `model`, `durationSeconds`, and optional `resolution`, `audioMode`, and `referenceImageCount` values. Apply the configuration, then choose **Estimate generation cost** in the node inspector.

The inspector displays the estimate, itemized video/audio/reference/minimum charges, pricing source, observation time and expiry. A missing, expired or incomplete schedule is shown as unavailable rather than replaced with a guessed price. Switching workflows, nodes or changing the node configuration clears the previous quote so stale estimates are not presented as current.

The UI calls only the authenticated read-only estimate endpoint. It does not run the workflow, submit a provider request, upload media, reserve credits or charge an account.
