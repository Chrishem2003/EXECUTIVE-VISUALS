# Runway Veo 3.1 execution adapter

**Implementation state:** adapter and request preflight implemented; provider availability remains disabled until the production worker composition, task-level billing resolver, private output ingestion and staging acceptance are verified.

## Supported models and operations

- `veo3.1`: standard Veo 3.1
- `veo3.1_fast`: Veo 3.1 Fast
- Text-to-video and image-to-video.
- Optional first and last keyframes; a last frame always requires a first frame.
- Native audio is enabled by provider default; `audio: false` requests silent output.
- Negative prompt and uint32 seed are supported.

The adapter uses the existing Runway API origin, pinned API version `2024-11-06`, task polling, temporary output URL handling, and the shared durable video worker contract.

## Request constraints

| Control | Supported values |
|---|---|
| Duration | 4, 6 or 8 seconds |
| Aspect ratio | 16:9 or 9:16 |
| 720p output ratio | 1280:720 or 720:1280 |
| 1080p output ratio | 1920:1080 or 1080:1920 |
| 1080p duration | 8 seconds only |
| Prompt | 1–1,000 characters for text-to-video; optional with first-frame input |
| Negative prompt | Up to 1,000 characters |
| Seed | Unsigned 32-bit integer |
| Keyframes | First frame required; optional unique last frame |

A first/last pair is sent to `POST /v1/image_to_video` as `promptImage: [{uri, position:"first"}, {uri, position:"last"}]`. Text-only requests use `POST /v1/text_to_video`. The adapter does not expose unsupported standalone reference-image semantics for this model family.

Private frame assets must be resolved through the authenticated project-scoped `prepareInput` callback and uploaded as short-lived Runway ephemeral inputs. Raw private asset IDs are never sent to the provider.

## Budget preflight

Preflight is estimate-only (`billable: false`) and uses the published Runway Dev credit schedule. It is not treated as actual provider usage.

| Model | Audio on | Audio off |
|---|---:|---:|
| Veo 3.1 | 40 credits/second | 20 credits/second |
| Veo 3.1 Fast | 15 credits/second | 10 credits/second |

The estimate converts credits at the published USD 0.01 per credit. The shared executor must still compare it with the user's approved reservation before submitting. The adapter requires an injected authoritative task-level `resolveActualCost` function and never settles a ledger from the preflight estimate.

## Security and release gates

- Construction does not submit provider requests.
- Remote execution remains disabled unless both existing Runway server-side opt-ins are enabled.
- The API key is server-only.
- Submission network ambiguity is quarantined by the shared worker; do not blindly retry a POST.
- Output URLs are temporary and must be ingested into owner-scoped private storage before the job is considered complete.
- Actual billing must come from authoritative task-level evidence; preflight pricing is never used as settlement.
- Catalog availability remains `disabled`; this adapter commit does not enable model selection, configure credentials, or activate paid calls.

## Sources

- Runway Veo 3.1 integration and current price schedule: https://dev.runwayml.com/learn/veo-3-1-api
- Runway API reference: https://docs.dev.runwayml.com/api/
- Runway API version 2024-11-06 image keyframe schema: https://docs.dev.runwayml.com/api-details/versions/2024-11-06/
