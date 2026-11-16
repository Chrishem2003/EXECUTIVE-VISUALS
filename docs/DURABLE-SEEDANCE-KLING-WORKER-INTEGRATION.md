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

- Set `draft: true` and explicitly set `resolution: "480p"` in the quoted request.
- The server rejects a draft request with any other resolution, model, or unsupported video mode before budget reservation.
- The adapter sends `draft: true` with the 480p ratio; it does not silently reinterpret a 720p/1080p quote as a draft.
- The PostgreSQL enqueue policy independently checks the JSON boolean, model, resolution, and reference-only video mode.
- The preview uses the dated 480p Runway rate card: 20 credits per output second, plus 10 credits per second of input/reference video (combined video capped at 30 seconds), subject to the 80-credit minimum.

**Not yet implemented in this batch:** the follow-on `draftTaskId` enhancement submission. A draft is therefore a billable preview asset, not yet a one-click draft-to-1080p workflow. The enhancement must be a separate quoted, approved, idempotent durable job, with the provider task ID linked to the preview and the 1080p charge shown separately. Do not infer that linkage from the preview's output asset ID.

No live provider call is made by tests. Provider execution remains disabled unless the existing server-side gates, private output ingestion, budget approval and authoritative task-level billing resolver are configured.
