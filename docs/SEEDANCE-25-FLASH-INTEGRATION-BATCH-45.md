# Batch 45 — Seedance 2.5 Flash integration

## Why this batch

Runway Dev released Seedance 2.5 Flash on 2026-11-16. It is a lower-cost Seedance 2.5 variant for 4–30 second video generation at 480p and 720p, with optional generated audio and reference media.

Official references checked 2026-11-22:
- Model guide: https://docs.dev.runwayml.com/guides/models/
- Input parameters: https://docs.dev.runwayml.com/assets/inputs/
- Pricing: https://docs.dev.runwayml.com/guides/pricing/
- Changelog: https://docs.dev.runwayml.com/changelog/

## Pricing contract

- 480p output: 13 Runway credits per output second.
- 720p output: 20 Runway credits per output second.
- 480p input/reference video: 7 credits per second.
- 720p input/reference video: 10 credits per second.
- Minimum generation charge: 52 Runway credits.
- Combined input/reference video duration is capped at 30 seconds.
- Up to 10 reference images, 5 reference videos and 5 reference audio clips.
- Video-to-video reserves one video slot for the source clip.
- 4–30 second duration range; 1080p, 4K and draft mode are not supported. The current worker contract emits MP4; MOV is documented by Runway but is not exposed by this adapter yet.
- Runway provider credits are cost units; they are not Executive Visuals customer credits.

## Implementation

- Added dated Seedance 2.5 Flash cost estimation, including output tier, input/reference video duration, minimum charge and documented reference-count validation.
- Wired reference video count through the shared generation cost estimator.
- Added the model profile, ratio mappings, reference limits and capabilities to the Runway gateway.
- Added private ephemeral upload handling and worker submission for text-to-video, image-to-video and video-to-video edit/extend/reference operations.
- Added the model to the provider catalogue with its capabilities and cost contract.
- Added tests for pricing, preflight estimates, gateway payloads, private image uploads, video edits and provider catalogue policy.

## Safety and release state

- The model remains `availability: disabled` in the provider registry.
- Existing remote execution gates, private asset ingestion, authoritative task billing and server-side approvals remain required.
- Draft preview/enhancement is not enabled for Flash.
- No live provider call, customer credit charge, subscription grant, production migration, merge or deployment was performed by this batch.
- Public list prices are forecasts. They are not invoice evidence or actual contract costs. The actual billing resolver remains authoritative for settlement.
