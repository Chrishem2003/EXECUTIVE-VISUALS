# Product integration and scale plan

**Updated:** 1 November 2026  
**Target:** one dependable, multi-user visual production platform  
**Status:** engineering plan; no cloud resources provisioned and no public release approval implied.

## Product direction

The product should behave as one production environment with a shared project, asset, identity, workflow, timeline, review and usage model. Creative modules must not create isolated copies of projects or assets. Every deliverable should be traceable from brief and source references through approved workflow runs, generated or edited derivatives, timeline versions, review decisions and export.

The core user journey is:

1. Create an account and workspace; invite collaborators with least-privilege roles.
2. Create a production project and define its brief, audience, brand rules, rights and consent.
3. Plan a campaign, series, episode, scene, shot and asset requirements.
4. Assemble a visual workflow; validate types, dependencies, costs, rights and approval gates before execution.
5. Run local or explicitly enabled provider operations with observable progress, cancellation and retry.
6. Review media and timeline versions with timecoded feedback; approve or request changes.
7. Export platform-specific deliverables with captions, audio, provenance and a reproducible production record.

## Delivery order

### P0 — Make the hosted product safe to use

- Replace manual access-token entry with ordinary Supabase Auth sign-in/sign-up, email confirmation, password recovery, session refresh and logout. Keep tokens in memory or secure server-managed sessions; never persist access tokens in localStorage.
- Add signup abuse controls, login throttling, generic authentication errors, session expiry handling and a clear account-disabled path.
- Complete project role enforcement consistently across projects, creative documents, workflows, jobs, assets, timelines, reviews, exports and audit records.
- Connect the active asset API to private object storage; use short-lived signed downloads, ownership checks, checksum verification, byte limits and safe cleanup.
- Move job state and worker leases to the isolated Postgres schema before supporting multiple hosts. Keep the SQLite/local mode as a development option only.
- Add resumable uploads, safe range downloads, retention controls and storage quota enforcement.
- Add health/readiness endpoints that distinguish process health, database connectivity, storage connectivity, worker heartbeat and provider readiness.
- Add operational logs with request/job correlation IDs, redaction, bounded retention and no prompt/media/secret leakage.

**Exit criteria:** separate owner/editor/reviewer/viewer accounts pass hosted end-to-end isolation tests; session refresh and recovery work; uploaded assets survive restart; unauthorized asset URLs fail; two workers cannot claim the same idempotent job; cancellation and stale-lease recovery are demonstrated; backup restore is proven.

### P1 — Complete the professional editing and review loop

- Build browser timeline preview with proxy-first playback, waveform display, frame-accurate seek, track mute/solo, snapping, undo/redo and autosave conflict handling.
- Add transitions, keyframes, motion transforms, animated overlays, video overlays, title/lower-third templates and audio ducking with explicit render parity tests.
- Add review annotations (draw/shape/region), version comparison, reviewer assignments, approval checkpoints and expiring share links with revocation.
- Add render profiles for social, web, broadcast and archive; include codec, dimensions, frame rate, audio loudness and caption validation.
- Add render resume/checkpoint support, progress estimates, output verification and retry-safe finalization.
- Add project templates, brand kits, reusable lower thirds, caption styles and shot/scene templates.

**Exit criteria:** a user can import media, edit and preview a multi-track sequence, invite a reviewer, resolve timecoded/visual feedback, render multiple deliverables and reproduce the final export from a saved timeline version.

### P2 — Connect real creative engines responsibly

- Keep all providers behind typed capability contracts and server-side adapters. Track support for references, masks, start/end frames, audio conditioning, duration, frame rate, resolution, aspect ratio, seed, negative prompt, editing and cancellation.
- Maintain model/provider readiness states: specified, implemented, contract-tested, connected and live-verified. Credentials alone never mean a model is ready.
- Add image generation/editing, text/image-to-video, start/end-frame video, video-to-video, inpainting/outpainting, background/object removal, speech synthesis, transcription, translation and dubbing as independently tested adapters.
- Add a provider/model comparison matrix with supported controls, quality evidence, regional availability, retention policy, verified price source/date and latency.
- Require an explicit user budget per project/job, estimate cost before dispatch where pricing is verifiable, enforce hard spend ceilings and record actual usage. Unknown price means blocked or user-confirmed manual override—not a fabricated estimate.
- Support provider callbacks/polling, idempotent submission, webhook signature verification, cancellation, rate-limit backoff and normalized error handling.
- Keep generated media provenance, provider/model identifiers, parameters, consent scope and source lineage.

**Exit criteria:** every live provider has contract tests and an opt-in smoke test; a real paid call is never made by CI; cost ceilings are enforced; failed or duplicate provider submissions do not create duplicate billable work.

### P3 — Quality, intelligence and scale

- Build a media QA pipeline that combines technical checks (codec, resolution, frame rate, black/freeze/silence/clipping) with optional perceptual checks and human review. Heuristics must never claim subjective quality as fact.
- Add visual similarity and continuity comparisons for identity, wardrobe, props, location, lighting and color, with per-shot override and reviewer sign-off.
- Add scene/shot detection, transcript alignment, subtitle quality checks, safe-area checks, aspect-ratio reframing and loudness compliance.
- Add model evaluation fixtures and regression sets for image/video quality, motion coherence, prompt adherence, identity/consent and failure rates.
- Add semantic asset search using embeddings only after privacy, deletion, tenant isolation and retention policies are tested; retain deterministic metadata search as fallback.
- Add workflow templates, reusable subgraphs, batch runs, conditional branches, schedule triggers and webhook triggers with approval gates.
- Add multi-region/object storage strategy, queue partitioning, worker pools, resource quotas, autoscaling policy and disaster recovery after measured demand justifies them.

**Exit criteria:** quality metrics are reproducible and versioned; resource quotas prevent noisy-neighbor failures; load tests and recovery drills meet published service objectives.

## Non-negotiable engineering rules

- No direct copying of proprietary code, private prompts, model weights, private APIs or protected assets. Reimplement independently from lawful public documentation and observable behavior.
- No hidden paid usage. Remote provider execution is disabled by default and requires approval plus a budget check.
- Never expose service-role keys, provider secrets or raw internal storage paths to the browser.
- Never reuse another product's database or storage bucket. The isolated project must be reviewed before migration.
- Preserve originals; derivatives are immutable, checksummed and linked to their source.
- Do not label an operation "AI" unless a verified model inference actually ran. FFmpeg scaling is conventional resizing, not neural super-resolution.
- A green source build is not a public-release approval. Hosted auth, storage, isolation, recovery, monitoring and user-acceptance gates are mandatory.

## Current blockers to close first

1. Browser auth is still a manual Supabase access-token gate.
2. The active runtime asset API still uses local disk; the private cloud storage adapter is not yet wired through the active asset lifecycle.
3. SQLite remains the active runtime database; the cloud Postgres queue and worker pieces are not yet the verified hosted runtime.
4. The Render blueprint is staging-only and requires paid compute plus persistent disk; no service has been created.
5. The latest deployment-guard workflow was pending at last inspection; rerun and inspect before treating it as passed.
6. Neural upscaling must remain unavailable to ordinary users until the model binary/weights are present, a worker self-test passes, output integrity is verified and an independent quality benchmark is recorded.

## Next engineering slice

Implement the authentication UX and session lifecycle first, then connect private object storage to the active asset API and browser library. Keep the branch in draft until those changes pass unit, integration and hosted staging tests. Do not create paid infrastructure or apply migrations until the user approves the isolated project and recurring costs.
