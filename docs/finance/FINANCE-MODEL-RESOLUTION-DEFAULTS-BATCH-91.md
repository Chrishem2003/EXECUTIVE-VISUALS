# Batch 91 — finance benchmark model-resolution correction

**Status:** targeted UI default correction; no pricing, plan, or billing activation.

## Change

The Financial Command Centre's default subscription-economics scenarios now request:

| Provider model | Default resolution | Reason |
|---|---|---|
| Runway Gen-4.5 | 720p | Gen-4.5's documented text-to-video endpoint currently exposes 720p |
| Seedance 2.5 | 1080p | Supported output resolution |
| Kling 4.0 | 1080p | Supported output resolution |

The prior Gen-4.5 default incorrectly requested 1080p. That could make the benchmark fail against a governed rate card or misrepresent a model configuration.

## Pricing caveats

- Runway Gen-4.5 list price is USD 0.12 per output second.
- Seedance 2.5 1080p list price is USD 0.68 per output second.
- Kling 4.0 1080p list price is USD 0.235 per output second.
- Kling 4.0 is currently advertised with a temporary 20% promotion through November 30, 2026. The benchmark must use the effective governed rate card for its selected date; a temporary promotion must not overwrite the underlying list-price record.

Sources checked 23 November 2026:
- https://dev.runway.com/endpoints/text_to_video
- https://dev.runway.com/learn/ai-video-api-pricing
- https://dev.runway.com/learn/kling-4-0-api

## Safety

- No provider rate card is seeded or modified.
- No customer credits, subscription allowances, plan visibility, or prices are changed.
- No provider API call, invoice posting, payment, migration, production deployment, or merge is performed.
