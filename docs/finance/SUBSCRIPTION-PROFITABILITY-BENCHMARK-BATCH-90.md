# Batch 90 — subscription profitability benchmark

Status: read-only benchmark and regression coverage; not a commercial price approval.

## Dated provider evidence

The benchmark uses the Runway Dev published API pricing guide, checked 22 November 2026:

- Runway Gen-4.5, 720p: USD 0.12 per output second; USD 1.20 for 10 seconds.
- Kling 4.0, 1080p: USD 0.235 per output second; USD 2.35 for 10 seconds.
- Seedance 2.5, 1080p: USD 0.68 per output second; USD 6.80 for 10 seconds.

Source: https://dev.runway.com/learn/ai-video-api-pricing

The guide says 1 Runway Dev credit equals USD 0.01 and that the prices are list prices before volume discounts. This benchmark uses provider API list prices, not Runway consumer-app credits. Model names, provider routing, billing dimensions, and rate-card versions must still match the exact production adapter before a quote is billable.

## Hypothetical plan-credit scenario

The regression suite uses the existing server-owned quote policy assumptions:

- 100 customer credits per USD of minimum sale price
- 65% target contribution margin
- 3% payment-fee reserve
- 5% support reserve
- 70% of monthly plan price earmarked for the illustrative included-credit budget

The resulting *hypothetical* monthly credit budgets are:

| Plan | Proposed monthly price | Scenario credit budget |
|---|---:|---:|
| Starter Creator | USD 9 | 630 |
| Professional Creator | USD 29 | 2,030 |
| Studio | USD 79 | 5,530 |
| Agency | USD 199 | 13,930 |
| Enterprise | Custom | 0 until priced |

These are scenario outputs, not published entitlements. The 70% budget share is an explicit test assumption, not a recommendation or approved customer allowance.

## Why a single-model allowance is not enough

At the dated 10-second list prices, one generation costs USD 1.20, USD 2.35, or USD 6.80 before retries, input-video charges, taxes, FX, storage, delivery, or other overhead. A customer who mixes models can consume the same credit budget much faster than one who uses only a low-cost model.

### Reference-video input exposure

Output-only examples understate costs for editing and video-to-video workflows. The benchmark now adds a second 10-second request shape with a 10-second source video:

| Model | Output charge | Input-video charge | Combined provider cost |
|---|---:|---:|---:|
| Seedance 2.5, 1080p | $6.80 | $3.40 | $10.20 |
| Kling 4.0, 1080p | $2.35 | $1.41 | $3.76 |

The Seedance input-video rate is $0.34 per second at 1080p. Kling's 1080p input-video rate is $0.141 per second; the provider bills output seconds plus the longer of input-video duration and output duration. These examples assume a 10-second source and a 10-second output, with no additional references, HDR surcharge, retries, or other billable inputs.

Sources: [Seedance 2.5 API pricing](https://dev.runwayml.com/learn/seedance-2-5-api) and [Kling 4.0 API pricing](https://dev.runwayml.com/learn/kling-4-0-api).

### Versioned Gemini Omni rates (checked 23 November 2026)

The earlier unversioned `gemini_omni_flash` scenario was ambiguous. The benchmark now uses the exact Runway Dev model IDs and their model-specific documentation:

| Runway Dev model ID | Resolution | 10s output | 10s source-video input | 10s edit/reference example |
|---|---:|---:|---:|---:|
| `gemini_omni_flash_1.1` | 720p | $1.00 | $0.10 | $1.10 |
| `gemini_omni_flash_1.2` | 720p | $0.70 | $0.10 | $0.80 |

Gemini Omni 1.2 Flash is the lower-cost 720p candidate; it supports 3–15 second outputs, while 1.1 supports 3–10 seconds. Input-video billing is additional to output billing. Image references are separately charged per image and are not included in these examples.

Sources: [Gemini Omni 1.1 Flash API pricing](https://dev.runwayml.com/learn/gemini-omni-flash-1-1-api) and [Gemini Omni 1.2 Flash API pricing](https://dev.runwayml.com/learn/gemini-omni-flash-1-2-api).

### WAN 3.0 and MiniMax H3 Max comparison (checked 23 November 2026)

The benchmark adds three more official Runway Dev routes, using exact model IDs:

| Model ID | Resolution | Rate per second | 10s output |
|---|---:|---:|---:|
| `wan3` | 720p | $0.10 | $1.00 |
| `wan3_prime` | 720p | $0.14 | $1.40 |
| `h3_max` | 768p | $0.08 | $0.80 |

WAN 3.0 and WAN 3.0 Prime accept video references without an additional reference-media charge on this route. MiniMax H3 Max supports 5–15 second text/image-to-video generation; the benchmark uses its 768p output rate. These are not resolution-identical comparisons, and H3 Max does not imply video-to-video support.

Sources: [WAN 3.0 API pricing and model IDs](https://dev.runwayml.com/learn/wan-3-0-api) and [MiniMax H3 Max API pricing and model ID](https://dev.runwayml.com/learn/minimax-h3-max-api).

The regression suite therefore checks:
1. Dated output-only and source-video provider costs remain explicitly marked forecast-only and non-billable.
2. The five proposed tiers remain private draft hypotheses with no persisted credits.
3. The same credit quote policy prices each model independently.
4. A mixed workload can fail a plan's credit allowance even where a per-model-only comparison looks affordable.
5. Contribution margin and credit sufficiency remain separate assessments.
6. Video-to-video scenarios include provider-billed reference-video input charges rather than treating edits as output-only.
7. The current Runway Dev Gemini Omni Flash rate is dated separately from the older Google-direct price announcement.
8. No scenario output publishes plan pricing, grants credits, or replaces invoice-backed actual cost evidence.

## Release and finance controls

- Add or update governed provider rate cards only after exact model IDs, provider billing dimensions, source URL, checked timestamp, and effective dates are verified.
- Do not automatically seed this benchmark into a production rate-card table.
- Compare forecast to posted invoice attribution by provider, model, operation, and request dimensions.
- Include failed-but-billable requests, retries, refunds, reference-video inputs, and discounts in actual settlement before setting commercial allowances.
- Keep storage, delivery, taxes, acquisition, infrastructure, refunds, and overhead outside the displayed contribution metric until their measured costs are available.
- Require finance/product approval before any plan price or credit allowance is published.

This batch adds regression evidence only. It does not activate billing, change live plans, grant credits, call a generation provider, or deploy production changes.
