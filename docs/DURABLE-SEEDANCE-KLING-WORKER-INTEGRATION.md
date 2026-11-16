# Durable Seedance 2.5 and Kling generation

**Implementation branch:** `feat/durable-runway-seedance-kling-worker-mainline`

This change closes a gap between the Runway direct gateway's supported model catalogue and the durable cloud-video worker.

## Durable models

The shared cloud worker can register these exact Runway model IDs, subject to its existing server-side gates and authoritative task-level cost resolver:

- `gen4.5`
- `seedance2_5`
- `kling_4`
- `kling3.0_standard`
- `kling3.0_pro`
- Existing source-operation profiles: `aleph2`, `magnific_video_upscaler_creative`, `ruby`

## Supported in this implementation

- Text-to-video for Seedance 2.5 and Kling 4 / Kling 3 profiles.
- First-frame image-to-video for those profiles.
- Seedance 2.5 and Kling 4 video-to-video using owner/project-scoped private source assets and model-specific source validation.
- Seedance 2.5 reference, extend and edit modes; edit mode requires `duration: "auto"`.
- Model-gated native audio controls for Seedance 2.5 and Kling 3.0 Standard/Pro. Kling 4 is treated as always-audio and does not receive an unsupported toggle.
- Model-specific duration, aspect-ratio and resolution validation reused from the direct gateway request builders.
- Seedance 2.5 prompt limit aligned to 15,000 characters; other supported profiles retain their documented bounded limit in the current request builder.
- Existing durable task polling, cancellation, private output ingestion and task-level cost reconciliation remain in the shared worker lifecycle.

## Deliberate limitations

Kling 3 multi-shot prompt segmentation is implemented through providerSettings.multiPrompt (up to six segments, each 3–512 characters, total duration 3–15 seconds). This is not the separate Runway multi_shot_video recipe endpoint, and per-shot editable outputs are not created. Last/middle keyframes, large reference image/video/audio collections, and other provider-side advanced controls remain unadvertised until their own contracts and acceptance tests are complete. The UI must not advertise unsupported controls.

## Configuration and safety

No provider credentials are included. No paid generation requests are made by tests. The worker remains disabled unless all existing cloud-worker and remote-execution gates are explicitly enabled. Every production adapter registration still requires private output ingestion and authoritative task-level billing evidence. Model registration alone does not enable production execution.
