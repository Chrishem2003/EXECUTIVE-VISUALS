# Runway video pricing snapshot — 2026-11-04

This document records the public Runway Dev pricing formulas used by
`server/runway-video-pricing.mjs`. The estimator is a local planning aid.
It is not a quote, invoice, usage receipt, or settlement authority.

Source: https://docs.dev.runwayml.com/guides/pricing/

## Covered models

| Model | Published formula used |
|---|---|
| Gen-4.5 | 12 credits/second |
| Gen-4 Turbo | 5 credits/second |
| Act-Two | 5 credits/second |
| Kling 2.5 Turbo Pro | 12 credits/second |
| Kling 3.0 Standard | 9 credits/second without audio; 13 with audio |
| Kling 3.0 Pro | 12 credits/second without audio; 17 with audio |
| Kling 3.0 4K | 43 credits/second |
| Kling O3 Standard / Pro / 4K | 13 / 17 / 43 credits/second |
| WAN 3.0 | 5 / 10 / 20 credits/second at 480p / 720p / 1080p |
| WAN 3.0 Prime | 6.8 / 14 / 28 credits/second at 480p / 720p / 1080p |
| Seedance 2.0 | 14 / 30 / 40 / 150 credits/second at 480p / 720p / 1080p / 4K; 56-credit minimum |
| Seedance 2.0 Fast | 11 / 24 credits/second at 480p / 720p; 44-credit minimum |
| Seedance 2.0 Mini | 7 / 15 credits/second at 480p / 720p; 28-credit minimum |
| Seedance 2.5 | Output rate plus input/reference video rate, combined input capped at 30 seconds; 80-credit minimum |
| Grok Imagine Video 1.5 | 10 / 16 / 29 credits/second at 480p / 720p / 1080p, plus 1 credit per image/audio reference |
| Grok Imagine Video 1.5 Lite | 2 / 3 / 14 credits/second at 480p / 720p / 1080p, plus 1 credit per start-frame image |
| MiniMax H3 Max | 5 / 8 credits/second at 480p / 768p |
| MiniMax Hailuo 3 | 10 / 15 credits/second at 768p / 2K, plus 2 credits per image/keyframe and reference-video seconds (capped at 15) |
| Veo 3.1 | 20 credits/second without audio; 40 with audio |
| Veo 3.1 Fast | 10 credits/second without audio; 15 with audio |
| HappyHorse 1.0 | 15 / 30 credits/second at 720p / 1080p |
| Gemini Omni Flash | 10 credits/second for text/image video; image input adds 1 credit. Video-to-video is 11 credits/second of input video, capped at 10 seconds, plus 1 per reference image |
| Gemini Omni Flash 1.1 | 3.4 / 10 / 15 credits/second at 360p / 720p / 1080p, plus 1 per reference image and 1 per input-video second |
| Kling 4 | 720p and 1080p output/input formulas; temporary 20% discount through 2026-11-30 UTC |

The estimator requires an explicit pricing date. Kling 4's temporary discount
is applied only through 2026-11-30; later dates use the published list rates.

## Financial safety

- All results are labeled `published_price_estimate`.
- USD conversion uses the published $0.01 per credit rate.
- Estimates are not billable and cannot settle budget reservations.
- Missing audio choices or required resolutions fail closed.
- Unsupported models fail closed rather than inheriting a neighboring model's rate.
- Actual settlement must use task-correlated realized-cost evidence from the
  live Model Router response or another authoritative provider receipt.
- A dry-run estimate is never an actual-cost receipt.

## Not covered yet

The estimator intentionally does not invent formulas for models and operations
whose pricing is not represented in this snapshot, including Ruby HDR and
video-upscaling/frame-rate finishing. Add those only after their current
pricing units, output constraints and billing semantics are verified.
