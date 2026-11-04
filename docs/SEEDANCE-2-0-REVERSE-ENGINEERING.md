# Seedance 2.0 provider reverse-engineering snapshot

**Research snapshot:** 2026-11-04  
**Provider route:** Runway Dev API  
**Execution status in Executive Visuals:** disabled; adapter not implemented  
**Primary source:** https://dev.runwayml.com/learn/seedance-2-0-api

## Findings

Runway Dev exposes the official ByteDance Seedance 2.0 family through one Runway Dev project/API key and the same asynchronous task lifecycle:

- `seedance2`
- `seedance2_fast`
- `seedance2_mini`

Supported task endpoints are `POST /v1/text_to_video`, `POST /v1/image_to_video`, and `POST /v1/video_to_video`. Requests require the Runway authorization header and the pinned `X-Runway-Version: 2024-11-06` header. The create response returns a task ID; poll `GET /v1/tasks/{id}` until a terminal state. Successful output URLs are temporary and must be downloaded into private application storage before the task is considered complete.

## Shared capability contract

- Text-to-video, image-to-video and video-to-video.
- Native generated audio is enabled by default; `audio: false` requests silent output.
- Seed is an unsigned 32-bit integer.
- Prompt limit: 10,000 characters.
- Duration: 4–15 seconds or `auto`.
- Reference inputs: up to 9 images, 3 videos and 3 audio clips on text-to-video; video-to-video has one source video plus up to 2 reference videos and up to 3 audio references.
- Input/reference media are not charged; output duration is billed.
- `auto` reserves/bills 15 seconds upfront and refunds unused duration after completion.
- Input moderation failures may still be charged.
- Aspect ratio is expressed as an exact pixel-dimension `ratio` string and also determines output resolution. It is not a free-standing resolution selector.
- Full Seedance 2.0 accepts 24 documented pixel ratios across the three endpoints. Fast and Mini accept the smaller 12-ratio list and do not support 1080p/4K.
- Image-to-video can take up to two prompt images as first/last keyframes. Text-to-video accepts up to 9 image, 3 video and 3 audio references. Video-to-video accepts up to 9 image, 2 video and 3 audio references.

## Tier limits and dated list rates

Runway Dev documents 1 credit = USD $0.01 on the research snapshot date.

| Tier | 480p | 720p | 1080p | 4K |
|---|---:|---:|---:|---:|
| Seedance 2.0 | 14 cr/s | 30 cr/s | 40 cr/s | 150 cr/s |
| Seedance 2.0 Fast | 11 cr/s | 24 cr/s | Not supported | Not supported |
| Seedance 2.0 Mini | 7 cr/s | 15 cr/s | Not supported | Not supported |

Minimum generation duration is 4 seconds. Minimum charges are 56 credits (full), 44 credits (Fast) and 28 credits (Mini), matching four seconds at the 480p minimum rate. `duration: "auto"` reserves 15 seconds of credits upfront, then refunds unused duration after completion. The registry stores dated credit rates, endpoint-specific ratio values and tier-specific resolution eligibility. Do not assume Fast/Mini accept the larger ratio values from the full tier.

## Executive Visuals implementation boundary

The provider registry now describes the three tiers and their constraints, but each is deliberately marked:

- `availability: disabled`
- `executionAdapter: not_implemented`

This is metadata-only. It does not read a Runway key, submit tasks, make paid requests, enable model selection, or alter deployment configuration.

## Required adapter work before activation

1. Map normalized request fields to the three Runway endpoint payloads without silently dropping references/audio settings.
2. Validate image/video/audio references by owner, project scope, MIME type, size, duration and safe URL/upload origin.
3. Preserve request idempotency and durable task IDs across worker restarts.
4. Poll with bounded backoff; treat `THROTTLED` as queued, not failed.
5. Download temporary outputs and verify media signatures, dimensions, duration, codecs and size before private ingestion.
6. Reconcile estimated credits against provider task metadata and account usage; reserve/refund budgets idempotently.
7. Keep live execution behind explicit feature flags, per-project spend caps and approval.

## Related official references

- API reference: https://docs.dev.runwayml.com/api/
- Inputs: https://docs.dev.runwayml.com/assets/inputs/
- Pricing: https://docs.dev.runwayml.com/guides/pricing/
- Model Router: https://docs.dev.runwayml.com/model-routers/configuration/


## Runway video finishing research (separate from Seedance generation)

The current Runway API exposes dedicated finishing operations:

- `magnific_video_upscaler_creative` on `POST /v1/video_upscale`: source video up to 30 seconds; 720p, 1k, 2k or 4k output; billing is per output frame.
- `enhance_frame_rate` on `POST /v1/video_upscale`: input up to 300 seconds; documented output rates are 24, 25, 30, 48, 50, 60, 120, 23.98, 29.97 and 59.94 fps; billing is one credit per two seconds of input.
- `ruby` on `POST /v1/video_to_hdr`: SDR source up to 30 seconds and 4K; HDR10, HLG, ProRes and EXR delivery profiles; billing is 20 credits/second, or 40 credits/second above 4 megapixels.

The API supports task-based chaining. For a cost-efficient finishing plan, upscale at the source frame rate first, retime second, and apply Ruby HDR last. The upscaler's `fpsBoost` is intentionally disabled in the initial plan builder because it changes output frame count and therefore changes per-frame billing.

Executive Visuals now has `server/runway-video-finishing-plan.mjs`, an estimate-only plan builder that:
- Requires verified source duration, frame rate, dimensions, dynamic range, media type and SHA-256.
- Calculates frame-based upscaler cost, input-duration retiming cost and source-pixel-tier HDR cost.
- Converts provider credits into micro-USD budget units.
- Enforces upscale → frame-rate → HDR order.
- Requires explicit post-upscale dimensions before estimating a later Ruby step.
- Marks all steps remote and requires the existing pipeline's explicit remote approval and full-budget gate.

This is a planning contract only. It does not load a Runway credential, upload media, submit tasks, reserve funds or activate any provider adapter.

Official API workflow reference: https://dev.runwayml.com/learn/edit-and-finish-video-api
