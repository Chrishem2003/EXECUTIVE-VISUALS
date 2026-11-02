# Executive Visuals — next implementation roadmap

**Branch:** `feat/executive-visuals-unified-platform`  
**Decision:** continue implementation on the feature branch; keep PR #2 draft.  
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
