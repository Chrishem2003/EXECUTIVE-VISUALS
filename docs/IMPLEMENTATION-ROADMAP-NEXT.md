# Executive Visuals — next implementation roadmap

**Branch:** `feat/timeline-preview-transport`  
**Pull request:** [#8](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/8), draft and currently non-mergeable.  
**Decision:** continue implementation on this feature branch; reconcile the two-commit base divergence deliberately and preserve the more complete feature implementation.  
**Infrastructure posture:** no deployment, paid provider activation, database provisioning, migration, or changes to existing shared services without separate approval.

This roadmap is an engineering sequence, not a claim that the listed work is already implemented. Each phase must ship as a small, testable slice with an explicit commit and verification result.

## P0 — Make hosted identity safe and usable

### P0.1 Session architecture and threat model
- Replace the hosted browser's manual bearer-token entry with a normal sign-in flow backed by the server.
- Keep access/refresh tokens out of browser storage, URLs, logs, analytics, and error messages.
- Use a cryptographically random opaque session cookie (HttpOnly, Secure in production, SameSite), store only a keyed/hash-derived session identifier server-side, and apply short bounded session lifetimes.
- Protect refresh credentials at rest with a dedicated encryption key that is separate from Supabase keys; fail closed if the key is missing or malformed.
- Rotate sessions on authentication and refresh; revoke server-side on logout; detect reuse where the provider contract allows it.
- Add CSRF protection and strict Origin/Host checks for cookie-authenticated state changes; preserve same-origin local development.
- Add rate limits for sign-in, sign-up and recovery, uniform public errors, account recovery/confirmation, and session expiry tests.
- Do not enable hosted cookie auth until rotation, revocation, CSRF, origin, recovery and multi-user isolation tests all pass.

### Acceptance gates
- No browser access-token paste field in the hosted path.
- No access/refresh token returned in JSON or written to browser storage.
- Tests cover session fixation, invalid/expired/revoked sessions, CSRF, hostile origins, rate limiting, logout, refresh rotation and two-user isolation.
- Local development auth continues to work with existing tests.
- Any incomplete hosted flow remains disabled; no misleading “secure sign-in complete” status.

## P0 — Private cloud media lifecycle

### P0.2 Active asset API integration
- Keep local filesystem storage as the development backend; select cloud storage explicitly through server configuration.
- Fail readiness closed when cloud mode is selected but isolated-project credentials, private bucket configuration or required policies are missing.
- Integrate upload, metadata, private download, derivative creation, processing outputs and cleanup through one storage interface used by the active API and UI.
- Enforce owner/project role checks server-side for every operation. Never accept a client-supplied storage path as authority.
- Preserve SHA-256, byte size, MIME/signature verification, immutable originals, derivative lineage and audit records.
- Use short-lived signed downloads or authenticated streaming; do not expose public buckets or service-role credentials.
- Add bounded upload concurrency, interrupted-upload cleanup, idempotent retries, storage readiness without secret leakage, and quota/retention controls.

### Acceptance gates
- Tests prove cross-user/project isolation, viewer/editor/owner permissions, signed URL expiry, checksum mismatch rejection, oversized upload rejection, idempotent retries, interrupted-upload cleanup and local-backend regression.
- Cloud mode remains disabled until a separately approved, isolated application project and private bucket are configured.
- Do not reuse either existing shared/NEMA Supabase project or apply migrations to them.

## P1 — Upscaling quality, not just execution

### P1.1 Reproducible benchmark harness
- Keep the Real-ESRGAN adapter opt-in and distinguish execution success from quality verification.
- Add a small, legally usable fixture set spanning portraits, skin/hair, text, fine textures, animation, low-light and compression artifacts.
- Record input/output hashes, dimensions, scale, model ID/version, binary/model hashes, settings, wall time, peak memory where available, exit status and output validation.
- For paired reference images, calculate PSNR and SSIM; add LPIPS only where its dependency is available and its use is documented. For unpaired footage, produce an artifact-review sheet rather than inventing a ground-truth score.
- Check ringing, halos, invented detail, text distortion, faces, flicker across video frames, color shift and temporal instability.
- Keep original assets immutable and record each derivative's parent, settings and benchmark status.

### Acceptance gates
- CI verifies deterministic metadata, invalid outputs, dimension/scale expectations, timeouts, model-file changes and benchmark report schema without requiring a GPU.
- GPU/model inference benchmarks are an explicitly invoked local or approved runner job; ordinary CI does not download large weights or incur GPU costs.
- UI labels state “execution verified” separately from “quality benchmarked”; no general enablement until human side-by-side review is recorded.

## P1 — Editorial workflow quality

- Continue strengthening the timeline quality panel with a server-side preflight summary and export report.
- Add camera-framing/movement continuity findings alongside existing character, wardrobe, location, props, lighting and color-grade checks; findings remain advisory unless a documented invariant is enforced server-side.
- Add undo/redo and keyboard-accessible timeline actions only with revision-safe tests; never silently overwrite a newer saved timeline.
- Keep render jobs bounded by source duration, input bytes, output bytes, concurrency and available disk; expose progress and actionable failures.
- Preserve source assets, timeline revisions and derivative lineage.

## P1 — AI Transformation Studio

- Add video-to-video workflows for vehicle, wardrobe, object, background, person, style, removal and relighting transformations.
- Keep source assets immutable; store transformation requests, references, preservation constraints, provider/model declarations, approvals, output hashes and parent-child lineage.
- Require source/reference rights confirmation and explicit subject consent for person replacement.
- Reject unsupported operations, clip lengths, reference counts and preservation constraints before dispatch.
- Keep the request contract provider-neutral; do not enable remote execution until one adapter, private asset ingestion, cost preflight, asynchronous jobs and visual QA pass their release gates.
- Use the checkpointed finishing orchestrator for transformation, upscale, frame-rate, HDR, audio finishing and transcode steps; persist idempotent step receipts in the owner/project-scoped SQLite checkpoint store and resume only from checksum-matching successful checkpoints.
- **Progress:** the Enhancement Lab now creates and reloads private cloud transformation plans through authenticated `/api/cloud/transformations` routes backed by the existing `jobs` table. Owner/editor authorization, same-project source/reference validation, idempotency, rights and consent attestations, and separate budget approval are implemented. A local SQLite plan API remains available for development. Submission remains fail-closed because no verified transformation adapter is connected.
- Next: bind approval to an immutable plan hash and verified adapter manifest, verify person-consent evidence rather than relying on an attestation, integrate the checkpoint store with an authorized worker, and validate the existing isolated cloud schema without touching shared/NEMA databases.
- Require a known cost estimate for each remote step, an explicit approval ID and a budget covering the entire pipeline before dispatch. Never rerun a completed paid step just because a later finishing step failed.

## P2 — Provider and collaboration integrations

- Keep the provider registry capability-based and provider-neutral; distinguish documented, configured, tested and production-ready.
- Require explicit approval before remote generation; estimate provider costs before dispatch where pricing data is reliable, and display “unknown” rather than inventing cost.
- Add project invitations/review links only after authorization, expiry, revocation and audit tests are complete.
- Treat publish/export destinations as separate integrations with explicit permission and a review step.

## Release checklist

A phase is not complete until:
1. The implementation and regression tests are committed on the feature branch.
2. Typecheck, the complete build/verification suite and relevant security tests pass.
3. The implementation status and release gates reflect what is genuinely tested.
4. No secrets, user media, proprietary assets or unrelated project data are added to source control.
5. No remote service, paid provider, database, bucket or production deployment is changed without approval.

## Current known blockers

- Hosted sign-in UX still relies on manual bearer-token entry.
- Cloud object storage adapters are not yet wired into the active asset API/UI.
- Existing Supabase projects contain unrelated shared/NEMA data and must not be reused.
- Neural upscaler execution is not evidence of perceptual quality.
- The Render blueprint is staging-only and has not been deployed.

## P1 — AI ↔ editorial handoff contract (next vertical slice)

The AI generation path and manual editor must share durable project assets, not browser-only previews or provider-specific response objects. Treat this as a contract boundary before adding more generation controls.

- Define a provider-neutral generated-media receipt: project and job IDs, asset ID, media type, duration/frame rate/dimensions when known, checksum when verified, provider/model/version, prompt/reference lineage, moderation/rights state, approval receipt, and creation time.
- A completed generation is not editor-ready until the server has verified that the asset belongs to the active project, its stored media type and metadata agree, and the output is readable. Unknown metadata stays unknown; do not fabricate duration, codec, dimensions, or quality.
- Offer a single **Send to timeline** handoff that uses the same authenticated asset and timeline APIs as imported footage. It must not pass raw provider URLs, browser-local blob URLs, credentials, or untrusted storage paths into the editor.
- Place the asset on a compatible unlocked track at an explicit playhead position. Reject incompatible media/track pairs, missing assets, cross-project assets, invalid duration, and conflicting timeline revisions before mutation. Do not silently replace an existing clip.
- Keep generated originals immutable. Edits, transcodes, proxies, upscales, captions and audio mixes become derivative assets with parent IDs, operation settings, hashes where available, and durable job receipts.
- Support the reverse path: select a timeline range or clip and create an AI task draft with the exact source asset, source range, project context, references and preservation constraints. Creating a draft does not dispatch work; explicit approval and capability/cost preflight remain required.
- Preserve editor state if a save fails. Use optimistic revision checks and surface conflicts instead of overwriting another user's newer edit.
- Add contract tests for ownership/project isolation, media/track compatibility, invalid duration, stale revision, idempotent handoff, derivative lineage and failed persistence.
- **Progress (feature branch):** a cloud timeline handoff endpoint now resolves the asset through the owner-aware asset repository, requires matching generation-job metadata plus server-recorded readability/checksum verification, checks project ownership, timeline revision, track compatibility, locked tracks, clip identity and overlap, then persists through the revision-checked timeline repository. The editor exposes a cloud-only “Send verified generated media to timeline” action. This fails closed for assets without the required verification metadata; it does not treat a browser flag as proof.
- Acceptance requires a browser-level test of generation → asset verification → timeline insertion → manual edit → render job → output asset lineage. Until then, report the workflow as partially integrated, not end-to-end complete.

## P1 — Timeline and finishing correctness gates

- Do not expose speed remapping, transitions, keyframes, waveform analysis or effects as working controls until the preview model, persisted timeline schema, local renderer and cloud renderer agree on the same semantics.
- Introduce an explicit capability matrix for each operation: editable, previewable, locally renderable, cloud renderable, and verified by tests. Unsupported combinations must fail preflight with actionable explanations.
- Before rendering, create a revision-pinned render manifest containing timeline revision/hash, ordered assets and hashes, operation versions, frame rate, dimensions, audio settings, export profile, and required approvals. A changed timeline must create a new manifest rather than mutate a queued render.
- Make retries idempotent per render step and input manifest. Reuse only checksum-matching successful checkpoints; never rerun a completed paid operation merely because a later finishing step failed.
- Add cancellation and cleanup semantics for temporary files, bounded disk/CPU/time use, partial-output quarantine, and clear distinction between queued, running, failed, cancelled, completed, and quality-verified.
- Separate technical QC from creative QC: technical checks validate decodability, dimensions, frame rate, duration, audio presence/peaks, caption timing and checksums; creative review records human decisions about continuity, invented details, flicker, text, faces, color shifts and whether the result meets the brief.

## P1 — Product-grade usability and accessibility

- Add autosave state with explicit saved/saving/offline/conflict states, keyboard focus restoration after timeline rerenders, accessible names for icon-only controls, and non-destructive confirmation for operations that remove or replace content.
- Keep long-running generation and rendering in a durable job center with progress, retry eligibility, cancellation, logs safe for users, outputs, lineage and clear provider/cost status.
- Add project-level reusable delivery presets, brand kits, safe-area overlays, caption style presets and version comparison without duplicating source assets.
- Measure the whole workflow using synthetic fixtures and deterministic API tests; do not report production performance or real-provider quality without measured evidence.


## Latest release-gate update — 2 November 2026

- Delivery package review-history validation is now strict and regression-tested: decisions must match the receipt fingerprint, timeline revision and output asset; reviewer identity and canonical timestamps are required; duplicate reviewer decisions are rejected.
- Full GitHub Actions workflow passed on head `2ca834900d7b6d6e4c4b6b90fc420ff6ad87d473` (run [41508815429](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/actions/runs/41508815429)).
- The next release milestone is not another provider toggle: it is a dedicated staging acceptance run covering upload → edit/preview → revision-pinned render → private master verification → independent delivery review → package verification, plus the cloud asset lifecycle and benchmark review paths.
- PR #8 remains draft/non-mergeable. The feature branch is not to be force-synchronized; inspect and reconcile the base-only commits first. Do not apply the committed Supabase migrations to any shared or production database.
