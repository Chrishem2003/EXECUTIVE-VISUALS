# Durable Seedance 2.5 and Kling generation

**Implementation branch:** `feat/durable-runway-seedance-kling-worker-integration`

This change closes a gap between the Runway direct gateway's supported model catalogue and the durable provider-aware cloud worker.

## Durable models

The shared cloud worker can now register these exact Runway model IDs, subject to its existing server-side gates and authoritative task-level cost resolver:

- `gen4.5`
- `seedance2_5`
- `kling_4`
- `kling3.0_standard`
- `kling3.0_pro`
- Existing source-operation profiles: `aleph2`, `magnific_video_upscaler_creative`, `ruby`

## Supported in this slice

- Text-to-video for Seedance 2.5 and Kling 4 / Kling 3 profiles.
- First-frame image-to-video for those profiles.
- Model-specific duration, aspect-ratio and resolution validation reused from the direct gateway's request builders.
- Private source asset resolution and short-lived ephemeral Runway uploads for first-frame media.
- Exact provider/model worker registration, durable task polling, output ingestion and task-level cost reconciliation remain in the existing worker lifecycle.
- Seedance 2.5 prompt limit is aligned to the documented 15,000 characters; other model profiles retain the existing 1,000-character cap.

## Deliberate limitations

This does not claim Seedance/Kling video-to-video, end-frame interpolation, multi-shot recipes, audio references, or native audio controls. Those require separate model-specific contracts and acceptance tests. Do not expose them as selectable controls until implemented.

## Configuration and safety

No provider credentials are included. No paid requests are sent by tests. The worker remains disabled unless all existing cloud-worker and remote-execution gates are explicitly enabled. Every production adapter registration still requires private output ingestion and authoritative task-level billing evidence. Model registration alone does not enable production execution.
