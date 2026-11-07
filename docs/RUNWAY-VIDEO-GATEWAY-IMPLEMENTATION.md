# Runway video gateway — November 2026 model profile update

**Reviewed:** 2026-11-07  
**Gateway:** `server/runway-video-gateway.mjs`

## Newly supported adapter profiles

### Kling 4.0 Flash — `kling_4_flash`

- Text-to-video: 720p, 3–20 seconds, 26,000-character prompt budget.
- Documented text-to-video output dimensions are mapped for landscape, portrait, square and 21:9.
- First-frame image-to-video is supported and follows the first-frame aspect ratio; the adapter omits a forced ratio.
- Native generated audio is represented in the capability profile.
- The current adapter does not expose separate reference image collections, reference videos, or video-to-video editing despite the upstream model supporting them.

### Gemini Omni 1.2 Flash — `gemini_omni_flash_1.2`

- Text-to-video: 3–15 seconds, 4,000-character prompt limit.
- Exact output pixel ratios are mapped to 360p, 720p, 1080p and 4K tiers.
- First-frame image-to-video is supported with the documented pixel ratio mapping.
- The adapter currently uses an explicit integer duration (3–15 seconds); it does not yet expose the provider's automatic-duration reservation flow through the video workflow.
- Last-frame, multi-reference, reference-video, source-video edit and extension modes are not exposed by this gateway yet.

## Shared safety and execution

- Provider model IDs are allowlisted in readiness checks.
- Remote execution remains disabled unless server configuration and remote opt-in are both present.
- API credentials are read only on the server.
- Provider task IDs are polled asynchronously; task output URLs must be HTTPS on the provider CDN host; downloads are size-bounded and validated as MP4.
- Fake HTTP tests exercise request payloads, task polling and output validation; CI does not submit paid provider requests.

## Commercial and release gates

- Video estimates are separate from authoritative provider settlement. Do not invoice customers from `estimatedCostCredits`.
- The customer credit reservation, provider actual-cost reconciliation, ambiguous-submission operator workflow and refund path must be accepted end-to-end before selling these profiles.
- The worker currently returns one MP4 output. Multi-output batch fan-out and video-to-video modes remain separate work.
- Staging acceptance must verify private source-asset resolution, private output ingestion, ownership isolation, retries, cancellation semantics, usage ledger and billing reconciliation.
- Do not enable production execution based only on a passing CI build.

## Official sources

- Model catalogue: https://docs.dev.runwayml.com/guides/models/
- Input limits and model-specific modes: https://docs.dev.runwayml.com/assets/inputs/
- Pricing and model-specific billing: https://docs.dev.runwayml.com/guides/pricing/
- API reference: https://docs.dev.runwayml.com/api/
