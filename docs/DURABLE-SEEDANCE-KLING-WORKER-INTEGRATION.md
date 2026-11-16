# Durable Seedance 2.5 and Kling generation

**Implementation branch:** `feat/durable-runway-seedance-kling-mainline-v2`

This change closes a gap between the Runway direct gateway's supported model catalogue and the durable cloud-video worker.

## Durable models

The shared cloud worker can register these exact Runway model IDs through the Video Studio request contract, durable enqueue gate and worker allowlist, subject to remote-execution flags, private asset resolution and authoritative task-level cost reconciliation:

- `gen4.5`
- `seedance2_5`
- `kling_4`
- `kling3.0_standard`
- `kling3.0_pro`
- `kling3.0_4k`
- Existing source-operation profiles: `aleph2`, `magnific_video_upscaler_creative`, `ruby`

## Supported in this implementation

- Text-to-video for Seedance 2.5 and Kling 4 / Kling 3 profiles.
- First-frame image-to-video for those profiles.
- Seedance 2.5 and Kling 4 video-to-video using owner/project-scoped private source assets and model-specific source validation.
- Seedance 2.5 reference, extend and edit modes; edit mode requires `duration: "auto"`.
- Model-gated native audio controls for Seedance 2.5 and Kling 3.0 Standard/Pro/4K. Kling 4 is treated as always-audio and does not receive an unsupported toggle.
- Model-specific duration, aspect-ratio and resolution validation reused from the direct gateway request builders.
- Seedance 2.5 prompt limit aligned to 15,000 characters; other supported profiles retain their documented bounded limit in the current request builder.
- Existing durable task polling, cancellation, private output ingestion and task-level cost reconciliation remain in the shared worker lifecycle.

## Deliberate limitations

Kling 3 multi-shot prompt segmentation is implemented in Video Studio through providerSettings.multiPrompt (up to six segments, each 3–512 characters, total duration 3–15 seconds). This is not the separate Runway multi_shot_video recipe endpoint, and per-shot editable outputs are not created. Last/middle keyframes, large reference image/video/audio collections, and other provider-side advanced controls remain unadvertised until their own contracts and acceptance tests are complete. The UI must not advertise unsupported controls.

## Configuration and safety

No provider credentials are included. No paid generation requests are made by tests. The SQL migration `20261116140000_runway_direct_model_enqueue.sql` adds a guarded direct-model allowlist while preserving the existing budget reservation and approval path; it must be applied and validated in staging before any production rollout. The worker remains disabled unless all existing cloud-worker and remote-execution gates are explicitly enabled. Every production adapter registration still requires private output ingestion and authoritative task-level billing evidence. Model registration alone does not enable production execution.

## Seedance 2.5 draft preview contract

The durable adapter now supports the provider's 480p draft flag for text-to-video, image-to-video, and video-to-video **reference mode**:

- Set `draft: true` in the Video Studio node. The workflow contract fixes the billable preview tier at `480p`; users cannot quote a draft at a different price tier.
- The server rejects a draft request with any other resolution, model, or unsupported video mode before budget reservation.
- The adapter sends `draft: true` and an aspect-ratio-preserving 720p ratio value; Runway renders the preview at 480p. The quoted cost remains the 480p rate.
- The PostgreSQL enqueue policy independently checks the JSON boolean, model, resolution, and reference-only video mode.
- The preview is always 480p MP4; the follow-on enhancement is fixed at 1080p (4K requires a separate full generation). The preview uses the dated 480p Runway rate card: 20 credits per output second, plus 10 credits per second of input/reference video (combined video capped at 30 seconds), subject to the 80-credit minimum.

The follow-on `draftTaskId` enhancement is implemented as a separate quoted, owner-approved, idempotent durable job. The provider task ID is resolved from the persisted preview job and linked to the new 1080p task; the 1080p charge is quoted and approved separately. The API does not infer the provider task ID from the preview output asset ID. See the acceptance contract below.

No live provider call is made by tests. Provider execution remains disabled unless the existing server-side gates, private output ingestion, budget approval and authoritative task-level billing resolver are configured.


## Seedance draft enhancement

A preview enhancement is a separate, owner-approved 1080p generation. The Studio workflow offers an **Enhance completed draft to 1080p** operation. The API accepts the source cloud job ID and original provider task ID, then verifies that the source job:
- belongs to the authenticated owner and the same project;
- is a succeeded `video.generate` job from Runway Seedance 2.5;
- was created as a 480p draft;
- contains the same provider task ID in its persisted output; and
- was created within the provider's seven-day enhancement window.

The quote uses the original job's persisted duration, aspect ratio and audio setting, prices the follow-on at the 1080p rate, and creates a new budget approval. The worker sends the provider's exact enhancement payload: `model` and `draftTaskId` only. The original preview remains unchanged; the enhanced result is ingested as a separate private asset and separately settled. The enqueue SQL and server contract reject unverified or malformed enhancement requests.
