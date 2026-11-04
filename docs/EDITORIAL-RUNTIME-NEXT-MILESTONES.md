# Editorial Runtime — Next Engineering Milestones

**Date:** 2 November 2026  
**Repository:** CHRISHEM EXCLUSIVE VISUALS  
**Working branch:** `feat/timeline-descriptor-schema`  
**Status:** E1 local/cloud playback, verified proxy-first selection, synchronized multi-track audio, mute/solo, still-image overlays and SRT/VTT caption preview implemented. E2 versioned effects/keyframe/transition descriptors now validate, persist through OTIO metadata and appear in variant comparisons; render/preview execution and editor controls remain outstanding. See [Timeline edit descriptors](TIMELINE-EDIT-DESCRIPTORS.md). See [Sequence preview engine](SEQUENCE-PREVIEW-ENGINE.md) and [Private cloud media streaming](PRIVATE-CLOUD-MEDIA-STREAMING.md).

## Objective

Complete the existing editorial runtime around the current timeline, media adapters, project assets, review records and finishing pipeline. Extend the existing project and asset model; do not create a parallel editor, duplicate media library or second job system.

## Engineering order and acceptance gates

### E1 — Browser preview and frame-accurate transport

**Build**
- A preview monitor bound to the selected saved timeline revision and its authorized source assets. Local and cloud assets use the same editor source boundary; cloud media is streamed through an authenticated same-origin endpoint.
- Proxy-first playback with an explicit original-media fallback when a proxy is absent. The selector accepts only a smaller, SHA-256-verified `media.proxy` derivative linked to the exact source.
- Frame seeking based on rational frame-rate/timebase values; do not accumulate floating-point frame drift.
- Play/pause, step one frame backward/forward, jump to clip in/out, timecode display, zoom-to-fit and safe source-range clamping.
- Track mute/solo and audio monitoring where the browser media pipeline supports them. (Mute/solo controls remain outstanding; current local preview synchronizes enabled tracks and per-clip gain.)
- Clear loading, unsupported-codec, missing-media, stale-revision and decode-error states. (Primary-source decode and missing-asset feedback are implemented; stale-revision and cloud-stream states remain outstanding.)
- Abortable media loading and release of object URLs/media resources on source changes and unmount.

**Required verification**
- Seek boundaries at frame 0, final frame, clip in/out and non-integer frame rates.
- Audio/video source trim synchronization and proxy/original timebase parity.
- Source changes cancel stale requests; inaccessible assets never become playable through guessed URLs.
- Browser tests cover play, pause, seek, frame stepping, errors and revision changes.
- Preview is explicitly a preview; only a verified render is a delivery master.

### E2 — Non-destructive editing model

**Build**
- Typed transition, effect, keyframe and speed-ramp descriptors attached to timeline clips or clip boundaries.
- Stable IDs, schema versions, bounded parameters and deterministic defaults.
- Frame-based trim handles, snapping, ripple/roll/slip edits and keyboard shortcuts.
- Undo/redo through validated immutable edit operations; preserve the original sequence and existing variant lineage.
- A renderer capability matrix. Unsupported effects must be visibly unavailable and rejected by render validation, never silently ignored.
- Transition and effect render parity between preview and final render, or a clear preview-fidelity warning.

**Required verification**
- Timeline round-trip serialization preserves every supported field.
- Invalid, overlapping or out-of-range operations fail without partially mutating a saved revision.
- Speed changes preserve source-time mapping and audio policy.
- FFmpeg fixtures verify transitions, effects, speed changes and output duration.
- Golden fixture comparisons and regression tests protect existing synchronized audio, captions and still-image overlays.

### E3 — Creative continuity references

**Build**
- Reusable, project-scoped character, wardrobe, location, prop and scene reference entities.
- References link to existing private assets and carry provenance, rights, consent scope, descriptive metadata and version history.
- Shot-level continuity assignments with explicit inherit/override behavior.
- A continuity comparison workspace showing assigned reference versus submitted shot evidence.
- Human review status separated from automated similarity signals. Missing evidence remains unknown, not passed.

**Required verification**
- Tenant/project role isolation, asset ownership and rights/consent checks.
- Reference replacement creates a new version and never rewrites historical shot evidence.
- Shot overrides do not mutate reusable project defaults.
- Deletion/revocation behavior is tested against dependent shots and exports.

### E4 — Review, approval and revision history

**Build**
- Timecoded comments plus region/shape annotations stored against an exact timeline revision.
- Reviewer assignment, resolve/reopen, request-changes and approval decisions with actor and timestamp.
- Side-by-side or synchronized revision comparison using existing timeline variant lineage.
- Review history is append-only; later revisions do not rewrite earlier decisions.
- Expiring, revocable external review links only after secure token, scope and access tests pass.

**Required verification**
- Reviewer/viewer/editor permissions are enforced server-side.
- Comments remain anchored to their original revision when a new version is created.
- Approval is invalidated or re-requested when material delivery changes occur.
- Revoked links and unauthorized users cannot retrieve private media or review metadata.

### E5 — Delivery profiles and quality reports

**Build**
- Versioned profiles for vertical social, horizontal social/web, square, broadcast and archive.
- Explicit dimensions, aspect ratio, frame rate, container, video/audio codecs, bitrate policy, audio requirements and caption policy.
- Safe-area and crop checks, caption bounds/readability checks, audio signal checks and source/rights evidence.
- A preflight report distinguishing pass, review, blocked and not-run.
- Render output probe, checksum, duration and profile-conformance report before a delivery is marked complete.
- Preserve user overrides as a versioned delivery specification.

**Required verification**
- Invalid or contradictory profile settings fail before a render job is queued.
- FFprobe output must match the saved profile and current timeline revision.
- Missing evidence remains not-run; technical conformance is not a subjective quality certification.
- Retry and duplicate submission tests prove idempotent delivery finalization.

### E6 — Traceable production pipeline

**Build**
- Connect approved transformation plans, upscale, frame-rate conversion, audio finishing, captions, timeline render and delivery validation through the existing finishing-pipeline contract.
- Each stage records source checksum, settings hash, adapter/capability identity, approval, budget decision, job ID, output checksum and immediate-parent lineage.
- Resume only from matching, verified checkpoints; changed inputs/settings invalidate downstream checkpoints.
- UI shows stage status, progress, blocked reason, retryability and resulting derivative.
- Keep unsupported providers blocked. No paid execution without an explicit approved budget and a verified adapter.

**Required verification**
- End-to-end local fixture pipeline from source asset to validated delivery.
- Checkpoint reload after process restart; deterministic idempotency; conflicting receipt rejection.
- Cancellation and worker-lease expiry tests.
- No duplicate derivative publication after retry.
- Audit history connects the brief, approved plan, timeline revision, review decision and final output.

## Cross-cutting quality gates

1. Run focused unit and integration tests for each milestone.
2. Run `npm run typecheck`, `npm run verify:server`, the relevant timeline/render/finishing verifiers and `npm run build`.
3. Add browser-level tests for interactive editor behavior and keyboard accessibility.
4. Keep media, comments, references, jobs and timeline revisions project-scoped and role-checked.
5. Keep source media immutable; all edits and processing outputs are derivatives with checksum lineage.
6. Never expose provider credentials, service keys, internal paths or private object URLs to browser code.
7. Do not report a feature complete until implementation, automated tests and a real fixture demonstrate the claimed behavior.

## Delivery sequence

- **First:** E1 preview transport and frame/timebase correctness.
- **Second:** E2 non-destructive edit operations and render parity.
- **Third:** E3 reusable continuity references.
- **Fourth:** E4 revision-aware review and approvals.
- **Fifth:** E5 delivery profiles and preflight reports.
- **Sixth:** E6 end-to-end production orchestration.

E1 and E2 are the critical path for making the timeline a usable editor. E3–E6 build on the same revision, asset, permission and job contracts.

## Explicit exclusions

This specification does not authorize merging to `main`, production deployment, database migration, provisioning paid infrastructure, enabling external providers, spending generation credits or modifying existing production services. Those remain separate approval and release gates.
