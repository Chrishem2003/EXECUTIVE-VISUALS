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
- Aspect ratio is expressed as a pixel-dimension `ratio` string and also determines output resolution. It is not a free-standing resolution selector.

## Tier limits and dated list rates

Runway Dev documents 1 credit = USD $0.01 on the research snapshot date.

| Tier | 480p | 720p | 1080p | 4K |
|---|---:|---:|---:|---:|
| Seedance 2.0 | 14 cr/s | 30 cr/s | 40 cr/s | 150 cr/s |
| Seedance 2.0 Fast | 11 cr/s | 24 cr/s | Not supported | Not supported |
| Seedance 2.0 Mini | 7 cr/s | 15 cr/s | Not supported | Not supported |

Minimum generation duration is 4 seconds. The registry stores the dated credit rates and tier-specific resolution eligibility. Do not assume Fast/Mini accept the larger ratio values from the full tier.

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
