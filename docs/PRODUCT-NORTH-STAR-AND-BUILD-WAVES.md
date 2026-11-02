# CHRISHEM EXCLUSIVE VISUALS — Product North Star and Build Waves

**Snapshot:** 2 November 2026  
**Working branch:** feat/executive-visuals-unified-platform  
**Delivery model:** incremental, evidence-led, provider-neutral and approval-gated.

## Product north star

Deliver a serious creative operating system that can take a production from idea to approved, versioned, distributable media. The user describes an outcome; the system turns it into an editable production plan, resolves needed references and rights, proposes a workflow, checks engine compatibility and budget, executes only after approval, and returns traceable media assets that can be reviewed, edited and delivered.

The system must not disguise planning scaffolds as AI output, pretend unsupported models are connected, or mark unverified capabilities as complete.

## Product-wide capability map

### A. Creative direction and story development
- Brief intake, audience/channel goals, creative strategy and brand constraints.
- Research and source-backed claims, script and dialogue drafting, story arcs, hooks, CTAs and version history.
- Storyboards with scene/shot breakdown, action, blocking, lens, framing, camera movement, lighting, sound and duration.
- Visual style guides, color scripts, reference boards and shot-level overrides.
- AI director that proposes structured editable changes and explains its choices.

### B. Series and episodic production
- Series bible: premise, genre, format, tone, world rules, canon, themes, recurring motifs and audience promise.
- Season arcs: opening state, escalation, turning points, finale, unresolved threads and next-season hooks.
- Episode records: logline, objective, synopsis, act/beat sheet, script, scene list, shot list, runtime, recap and next-episode hook.
- Canonical character records: appearance, wardrobe, voice, personality, relationships, history, goals, reference assets, rights and continuity rules.
- Reusable locations, props, costumes, sound motifs, title sequences, lower thirds, graphics and brand packages.
- Character/scene continuity checker and approved-reference selection.
- Episode-specific overrides with inherited series defaults.
- Season and episode production boards, progress, review, approvals, localization and delivery status.
- Create an episode timeline from its shot package; keep the series, episode, source assets, timeline and final renders linked.
- Batch episode production with per-episode approval checkpoints and rerun-only-changed-shot behavior.
- Export production bible, scripts, shot packages, subtitle packs, asset manifest and episode masters.

### C. Generation and creative engines
- Text-to-image, image-to-image, inpainting, outpainting, background/subject operations and reference-conditioned image generation.
- Text-to-video, image-to-video, video-to-video, start/end keyframes, clip extension, shot continuation and supported motion references.
- Multi-shot generation and per-shot regeneration with global and local continuity controls.
- Presenter/avatar workflows: original and authorized identities, voice selection, speech, lip-sync, performance controls and consent scope.
- Native or separately generated dialogue, narration, music and sound effects; align all audio to scene and timeline timing.
- Capability registry per provider/model/version: input roles, output types, duration/resolution limits, references, audio modes, seed, aspect ratios, latency, pricing unit, region and commercial terms.
- Dynamic adapter routing based on user choice, quality, cost, latency, availability and measured evaluation.

### D. Editorial and post-production
- Multi-track video, image, audio, title, graphics and caption editing.
- Frame-accurate trim, split, ripple/roll edits, transitions, keyframes, speed ramps, transforms, crop/reframe, masks and compositing.
- Color correction and grading, LUT handling, scopes, shot matching and look presets.
- Audio mixing, gain, fades, ducking, noise cleanup, dialogue/music/SFX stems and loudness targets.
- Transcript-based editing, speaker labels, subtitle styling, caption localization and timing validation.
- Proxy media, thumbnails, waveform, background render, autosave, undo/redo and recoverable edit history.
- Professional export presets, codec/container selection, frame rate, resolution, bitrate, audio layout, captions and delivery manifests.
- Interchange formats where documented and tested.

### E. Enhancement and restoration
- Spatial upscaling at supported factors; face/detail restoration; denoise; deblur; deblock; deinterlace; stabilization; deflicker; frame interpolation; color correction; SDR/HDR conversion where supported.
- Temporal consistency checks: flicker, warping, detail pumping, face drift and edge artifacts.
- Before/after comparison, region inspection, model/version and parameter provenance.
- Benchmark suite covering portraits, faces, fine texture, text, animation, motion, low light/noise, compression and mixed scenes.
- Objective metrics where meaningful (PSNR, SSIM, LPIPS, VMAF) plus blinded human review. Metrics are not interchangeable and must not be treated as universal quality truth.
- Preserve originals; all enhancements create derivative assets with lineage.

### F. Asset, collaboration and delivery
- Private project library, tags, collections, semantic search, duplicate detection, metadata, checksums, versions and lineage.
- Project roles, invitations, review links with expiry/revocation, timecoded comments, annotations, approvals and change requests.
- Review proxies, comparison views, side-by-side versions, review history and sign-off.
- Export packages, captions, thumbnails, audio stems, provenance manifest and rights metadata.
- Publishing connectors with explicit destination authorization, preview, schedule and final confirmation.
- API/webhooks, project templates, batch jobs and scheduled recurring productions.

### G. Platform operations and trust
- Durable queue, idempotency, retries, cancellation, worker leases, concurrency limits and observable progress.
- Usage ledger with per-provider billing units; never invent cost when the rate is unknown.
- Preflight budgets, user quotas, organization limits and alerts.
- Server-side secrets, scoped tokens, private object storage, row-level access, audit history and data export/deletion controls.
- Identity and voice rights with documented scopes, expiry, evidence references and revocation.
- Safety review and policy checks before generation, voice/identity operations and publication.
- Provider outage isolation, circuit breakers, health checks, fallback routing and version pinning.

## Current verified foundation

The active pull request documents a substantial local-first runtime: project and asset persistence, local authentication, project roles, workflow graph validation and execution, durable local jobs, FFmpeg/FFprobe processing, multi-track timeline and MP4 rendering, research ingestion, approval-gated text/speech/transcription workflows, caption creation/localization, shot/character continuity records, cloud API code paths and benchmark evidence contracts.

These are not all production-live cloud services. Cloud migration, private bucket policy, hosted auth configuration, worker deployment, live external generation and advanced post-production remain gated. The feature branch must pass CI and staging checks before any release claim.

Series planning already supports seasons, episode scaffolds, scene and shot plans, a story bible, shot references, episode overrides, shot-package export, cloud project save and timeline creation. It remains a planning and handoff foundation: automated script/episode generation, complete canon/relationship management, batch execution, media generation, review and delivery need further implementation.

## Prioritized build waves

### Wave 0 — Brand and quality baseline
- Apply the CHRISHEM EXCLUSIVE VISUALS identity and purple design system consistently.
- Keep production branch untouched; all changes in the feature branch.
- CI, dependency audit, typecheck, test suite, production build and security checks on every change.
- Maintain an evidence ledger separating implemented, tested, staging-verified, production-ready, planned and blocked.

### Wave 1 — Production-grade core
- Complete cloud auth, storage, database and worker staging gates without touching production.
- Durable project/series/episode/scene/shot relationships and revision-safe updates.
- Cloud asset preview/playback and upload recovery.
- Job progress streaming, webhook verification, cancellation, retry and idempotency.
- User-facing usage/cost preflight and provider health status.

### Wave 2 — Series production engine
- Extend episode runtimes beyond short-form presets with explicit supported limits.
- Season arc and episode story structure, script/dialogue versions, character relationships and canon.
- Per-episode production checklist, shot readiness and continuity report.
- Batch planning and controlled execution; do not dispatch generation for an entire season without explicit user approval and budget.
- Timeline handoff with shot markers, asset placeholders and later replacement by approved media.

### Wave 3 — Generation adapters
- Complete provider-neutral contracts for image/video/audio/avatar workflows.
- Build deterministic mocks and adapter contract tests first.
- Implement one well-supported video adapter and one image adapter with async lifecycle, webhook/polling, private output ingestion and cost disclosure.
- Add reference, keyframe, extension, motion and native-audio support only when the exact model contract confirms it.
- Add an avatar/voice adapter with consent enforcement and source-to-output traceability.
- Keep all remote/billable calls disabled until staging test and approval.

### Wave 4 — Professional editing and enhancement
- Timeline playback/preview, transitions, transforms, keyframes, color, audio mix and undo/redo.
- Enhancement adapters for super-resolution, denoise, restoration, interpolation and stabilization.
- Real benchmark fixtures, model-pinned runs, metrics and blind review before promoting an engine.
- Export presets, captions, stems, thumbnails and delivery manifest.

### Wave 5 — Collaboration, localization and distribution
- Review links, timecoded comments, team roles, approvals and revision comparisons.
- Dubbing, voice assignment, translation glossaries, lip-sync and localized exports.
- Batch campaigns and series variants with asset reuse.
- Publishing connectors and recurring production schedules with explicit authorization.

### Wave 6 — Scale and enterprise readiness
- Multi-tenant isolation, quotas, billing, usage reporting, admin policies and observability.
- Worker autoscaling, GPU scheduling, queue fairness and region-aware storage.
- Provider outage handling, fallback routes and model regression monitoring.
- API/webhook ecosystem and integration marketplace.

## Non-negotiable release gates

1. No fake generation success or mock output presented as real media.
2. No external provider call without an explicit enabled adapter and required approval.
3. No cloud activation before isolated migration, RLS, private bucket, auth, worker and restore tests pass.
4. No production secrets, migrations or deployments altered by this development branch.
5. No unverified pricing or capability limits displayed as fact.
6. No real-person likeness or voice workflow without scoped, documented authorization.
7. No quality claim without reproducible benchmark evidence and review.
8. No product-facing external product branding or copied proprietary assets.
9. Every important feature has unit, API and end-to-end tests at the appropriate layer.
10. Every release has a rollback plan and a human-reviewed readiness declaration.

## Research caveat

Public pages and developer docs describe only public product behavior. Availability, plan access, API scope, geographic restrictions, model versions and pricing change. This roadmap is a synthesis of the repository's existing public-surface audit and a partial November 2026 web research pass; it is not an exhaustive verification of every current platform or private feature. Re-check primary docs before implementing each adapter.
