# Executive Visuals — market position, achievements and product restructuring

**Assessment date:** 2026-11-02  
**Working branch:** `feat/timeline-preview-transport`  
**Status:** engineering assessment; not a claim of commercial feature parity.

## Executive assessment

Executive Visuals has a substantial engineering foundation for a unified AI-assisted video production environment. Its strongest differentiator is the direction of the architecture: provider-neutral generation contracts, private project media, a non-destructive editor, governed transformation plans, render infrastructure and quality-evidence gates.

It is **not yet demonstrably best-in-market**. We do not yet have independent output-quality benchmarks, full browser-level generation-to-delivery proof, broad provider/model coverage in production, or the same depth of proven editorial polish and ecosystem integration as established creative suites. We should compete on a coherent production system and trustworthy workflow, not on feature-count claims.

## Verified project achievements

The current feature branch contains the following implemented foundations (some are opt-in and require isolated infrastructure/configuration before hosted use):

- **Timeline editing:** selected-clip local preview for video, audio and still images; source-range navigation; frame stepping; bounded scrubbing; ripple deletion; undo/redo; keyboard shortcuts; revision-aware persistence and rollback safeguards.
- **Generated-media handoff:** provider-neutral validation plus a cloud endpoint that verifies project scope, generation metadata, server-recorded readability/checksum evidence, media/track compatibility, duration, timeline revision and overlap before insertion. Idempotent retries are supported.
- **Private media foundation:** owner/project-aware asset repository, private storage adapter, short-lived signed URLs, bounded uploads/downloads, streaming file uploads, SHA-256 checks and derivative metadata.
- **Render foundation:** local/cloud FFmpeg rendering paths and cloud media materialization with integrity checks and temporary-file cleanup.
- **Finishing foundation:** video pipeline checkpoint stores with immutable/idempotent receipts and derivative lineage; AI upscaling adapter and quality benchmark record validation.
- **Upscaling governance:** candidate comparison groups by pinned model/version/binary/model-file hashes; summarizes execution, human review, fixture coverage, median/p95 latency and available metrics; no recommendation without all required reviewed fixture categories and zero failed/pending records.
- **AI transformation planning:** transformation operations, preservation constraints, rights/consent declarations, owner/project checks and cost/budget approval boundaries exist in the wider codebase; remote execution remains gated until a verified adapter and evidence checks are connected.
- **Verification:** the latest CI run for commit `1998439eb2c68dd1e510feeb07abe52bd7e40f83` passed `npm install`, `npm run typecheck` and `npm run build`. A further checkpoint idempotency improvement is now committed and awaits its own CI run.

## Market benchmark: what leading products demonstrate

This is a capability-direction comparison, not a scored head-to-head test. Official product documentation and announcements were reviewed on 2026-11-02.

| Market capability | Current market examples | Executive Visuals assessment |
|---|---|---|
| Multiple frontier generation models in one workspace | Runway lists multiple image/video/audio models and a creative toolkit; Adobe Firefly supports partner video models | Provider-neutral architecture exists, but breadth, adapter reliability and real output parity are not yet proven |
| Prompt-based video transformation | Runway's editing tools support transformations; Adobe documents prompt-based clip edits with partner models | Transformation planning and operation contracts exist; verified remote execution and comparative quality remain gaps |
| Generation inside a multi-track timeline | Adobe Firefly Timeline and Premiere's Generative Media Tool | Local timeline and cloud generated-media handoff foundations exist; complete browser workflow still needs proof |
| Story and shot continuity | Multi-shot and reference-driven generation capabilities are appearing across leading tools | Project/shot/continuity foundations exist in the wider product; consistent character/scene results need benchmarked evidence |
| High-quality finishing/upscaling | Runway provides video upscaling; professional suites have mature export/finishing workflows | Adapter and benchmark governance exist; actual GPU/model runs, temporal quality evaluation and delivery presets need completion |
| Production reliability and provenance | Mature tools provide history, project organization, collaboration and repeatable workflows | Checkpoints, hashes, approvals and lineage are architectural strengths; operational end-to-end evidence remains incomplete |

### Primary market references

- Runway product and model/workflow overview: https://runway.com/product
- Runway changelog and agent/model updates: https://runway.com/changelog
- Adobe Firefly Timeline with Runway models: https://helpx.adobe.com/firefly/web/firefly-video-editor/generate-videos/generate-videos-using-runway-video-models.html
- Adobe Firefly Timeline with Kling: https://helpx.adobe.com/firefly/web/firefly-video-editor/generate-videos/generate-videos-using-kling.html
- Adobe Premiere Generative Media Tool: https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-media-tool-overview.html
- Adobe prompt-based video editing: https://helpx.adobe.com/firefly/web/work-with-audio-and-video/work-with-video/edit-generated-video-using-text-prompts.html
- Kling creative workspace and node editing: https://kling.ai/

## Restructured product strategy

Do not build more isolated feature pages. Consolidate the product around one production journey and shared project/media/identity contracts.

### 1. Unified Studio shell
One project workspace with consistent navigation and a single project context:
- Home / project dashboard
- Create (brief, script, storyboard, shot list)
- Generate (provider-neutral model selector and generation history)
- Transform (video-to-video and image/video edits)
- Edit (multi-track timeline)
- Finish (upscale, denoise, frame-rate conversion, color/audio/captions)
- Review (technical QC, creative review, approvals)
- Deliver (export profiles, versioned outputs, publish integrations)

Every stage operates on the same project, assets and timeline revisions. Avoid duplicated project pickers, isolated asset libraries or feature-specific identity systems.

### 2. Shared production data plane
Make projects, assets, jobs, timeline revisions, transformation plans, render manifests, checkpoints and delivery records durable, owner/project-scoped entities. Keep originals immutable; all generated/processed media is a derivative with source hash, settings, model/build identity and parent asset.

### 3. Capability-aware orchestration
Every operation must declare whether it is documented, configured, tested, available locally, available in cloud, cost-known, approval-required and quality-verified. The UI must not present unavailable capabilities as working controls. Unknown costs or metadata stay explicitly unknown.

### 4. Production-grade finishing
Prioritize deterministic render manifests, render-step checkpoints, resumable/cancellable jobs, technical QC and visual review. The renderer must reject unsupported timeline features rather than silently ignoring them. Export profiles should be tested against actual output media.

### 5. Trust and collaboration
Finish hosted sign-in, role isolation, invitation/review access, audit history, rights/consent evidence, quotas and retention before opening multi-user production use. Do not reuse unrelated shared or NEMA databases.

## Prioritized delivery gates

### P0 — Prove one complete production journey
1. Authenticated user creates a project.
2. Upload/import an original asset into private project storage.
3. Generate or transform through one verified adapter (or import a verified generated asset while adapter work is gated).
4. Verify asset bytes, hash, probe metadata and project scope.
5. Send asset to timeline; trim, arrange and preview.
6. Render a revision-pinned manifest.
7. Run technical QC; store output as a derivative.
8. Reopen the project and verify history, lineage and playback.
9. Exercise two-user isolation, stale revisions, retries, cancellation and failure recovery.

**Exit criterion:** browser-level automated test passes against an isolated test environment; no paid provider or production infrastructure is required for CI.

### P1 — Finishing and quality leadership
- Run actual upscaler models on approved/licensed fixtures using an explicitly invoked GPU/local runner.
- Extend fixtures to face/skin/hair, text, fine texture, animation, low-light, compression and fast motion.
- Add temporal flicker/consistency analysis for video; per-frame PSNR/SSIM alone is insufficient.
- Record model binary/weights/settings, input/output hashes, resolution, scale, wall time, memory and human review.
- Add denoise, deblur, frame interpolation, color management, loudness normalization, caption QC and delivery presets only behind tested capability flags.
- Provide before/after comparisons and retain the untouched original.

### P1 — Editing and storytelling depth
- Add keyframes, transitions, speed remapping, audio waveforms, proxy media and nested sequences only when preview and renderer semantics match.
- Add shot/scene continuity review for character identity, wardrobe, props, location, lighting, camera framing and motion.
- Add transcript-based editing, subtitles, reusable brand kits, multi-format reframing and social cut-downs.
- Keep creative suggestions advisory unless backed by explicit deterministic rules.

### P2 — Provider breadth and collaboration
- Add adapters only when each has a documented capability contract, cost preflight, timeout/retry semantics, rights/moderation handling and output verification.
- Add multi-user review, comments, approvals, project invitations and publishing integrations after access-control and audit gates pass.

## Non-negotiable release rules

- No production merge/deployment or paid provider activation without explicit approval.
- No reuse or migration of unrelated shared/NEMA Supabase projects.
- No public media buckets or service-role credentials in the browser.
- No claim of “best”, “4K quality”, “production-ready” or “verified” without measurable evidence.
- CI remains GPU-free; large model weights and paid inference are opt-in.
- Every milestone must end with a commit, regression tests, full CI result and updated truthful status.

## Current gaps that block a market-leadership claim

1. Full browser-level generation → timeline → render → output-lineage test.
2. Authenticated private cloud playback and complete asset lifecycle integration in the active UI.
3. A pinned, executed and human-reviewed upscaling benchmark with temporal video quality checks.
4. Render manifests that bind an immutable timeline revision and source checksums to each output.
5. Mature timeline editing parity (keyframes, transitions, speed remapping, proxies, audio tools).
6. One coherent, polished UX across creation, editing, finishing, review and delivery.
7. Operational proof for multi-user collaboration, quotas, retention, cancellation and failure recovery.

**Bottom line:** the architecture is promising and the engineering foundations are real. The route to a best-in-class product is to finish and measure one complete production journey, then expand capability depth based on evidence—not to keep adding disconnected modules.
