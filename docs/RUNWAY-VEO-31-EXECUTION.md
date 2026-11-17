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

The estimate converts credits at the published USD 0.01 per credit. The shared executor must still compare it with the user's approved reservation before submitting. The adapter requires authoritative task-level `resolveActualCost` evidence and never settles a ledger from the preflight estimate. For Veo, the worker can construct this resolver only when `RUNWAY_WORKSPACE_USAGE_ENABLED=true`; it queries Runway's linked workspace usage endpoint and matches the exact provider task ID, model tool, transaction IDs and usage timestamp. This endpoint is requires the API project to be linked to an authorized Runway workspace account and requires the API project to be linked to the workspace. If the link is absent, the plan is not eligible, or the usage row has not settled, the budget reservation remains unresolved and the job is not billed as zero.

## Security and release gates

- Construction does not submit provider requests.
- Remote execution remains disabled unless both existing Runway server-side opt-ins are enabled.
- The API key is server-only.
- Submission network ambiguity is quarantined by the shared worker; do not blindly retry a POST.
- Output URLs are temporary and must be ingested into owner-scoped private storage before the job is considered complete.
- Actual billing must come from the exact per-generation workspace usage record; the aggregate daily organization usage endpoint is not sufficient for per-task settlement.
- Direct Veo registration requires `RUNWAY_WORKSPACE_USAGE_ENABLED=true`, a server-side Runway API key, the existing remote opt-ins, and a linked linked workspace. Other direct Runway profiles still require their own authoritative task-level resolver.
- Catalog availability remains `disabled`; this adapter commit does not enable model selection, configure credentials, or activate paid calls.

## Sources

- Runway Veo 3.1 integration and current price schedule: https://dev.runwayml.com/learn/veo-3-1-api
- Runway API reference: https://docs.dev.runwayml.com/api/
- Runway API version 2024-11-06 image keyframe schema: https://docs.dev.runwayml.com/api-details/versions/2024-11-06/
- linked workspace per-generation usage and task-level credit rows: https://docs.dev.runwayml.com/usage/workspace-reporting/
