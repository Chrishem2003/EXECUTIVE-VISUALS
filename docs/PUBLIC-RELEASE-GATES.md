# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Scope:** staging deployment review for the unified production application.  
**Last reviewed:** 14 November 2026.

## Mainline reconciliation — 14 November 2026 (supersedes older checkpoints below)

- **Current GitHub main:** `4221ec5b464820bdd3df1d1ab152cf26bc1fd098` (PR #588, FlashVSR temporal enhancement).
- **Deployment drift:** the previous verified Render production deployment recorded in this document is `6b21dc5`. This audit has not established that Render is running `4221ec5`; do not describe the latest GitHub main as deployed until the live service reports that exact commit.
- **Merged mainline slices #567–#588:** refreshed readiness records; Runway router syntax and cloud-checkpoint migration repairs; production ephemeral-upload guard and fail-closed upload readiness; reproducible Cloudflare Worker source/deployment tracking and live-API health checks; timeline fades/crossfades; optional private R2 adapter; audited publication cleanup; LPIPS and visual-quality assessment; model-backed Creative Director and persisted creative artifacts; storyboard compiler, cloud-timeline handoff and governed generation; gated FlashVSR temporal enhancement.
- **Not implied by those merges:** R2 is not provisioned or connected to customer media; FlashVSR is not enabled on Render Free and has no claimed real CUDA inference; LPIPS is an optional offline assessment, not an automatic approval; storyboard/generation paths still require the relevant model/provider approvals and runtime gates.
- **Known open integration sources:** PR #206 remains a 574-commit/180-file divergent integration candidate and must not be merged wholesale. PR #303 contains recurring-subscription lifecycle/cancellation work but is stacked on that old branch; extract it into a clean, dependency-ordered mainline PR. PRs #294 and #297 are superseded source branches for the quality-assessment and FlashVSR work already extracted in #587 and #588; do not merge them again.
- **Recurring subscriptions:** current main still lacks the Dodo recurring-subscription module and cloud subscription lifecycle-sync implementation. The existing local billing code is not proof that recurring customer subscriptions are production-ready.
- **Hosted persistence remains the critical release blocker:** the application needs a dedicated isolated Supabase project or a separately provisioned private R2 backend, correct auth/RLS/storage policies, durable worker execution, backups and hosted end-to-end acceptance. Do not reuse the connected NEMA/shared-platform Supabase projects.
- **Upload behavior is intentionally fail-closed:** production uploads must remain blocked while only ephemeral/local storage is available. Do not weaken the guard to make the UI appear functional.
- **No production settings, credentials, migrations, paid infrastructure, provider execution or deployment were changed by this reconciliation.**

## Next integration order

1. Extract recurring subscriptions from PR #303 onto a fresh branch from current main; include webhook idempotency, lifecycle transitions, customer cancellation, period-boundary and disposable-Postgres tests.
2. Extract only the still-missing Google Drive and provider-worker capabilities from PR #206, each as bounded vertical slices with exact-head CI.
3. Complete isolated hosted persistence and identity configuration before enabling customer uploads or cloud workers.
4. Verify the live Render commit, hosted authentication, upload/download, job execution, cancellation, timeline render, recovery and backup/restore.
5. Keep all paid generation and subscription collection disabled until pricing, merchant acceptance, provider credentials and operational controls are explicitly approved.

## Evidence and release rule

A successful source build or GitHub merge is necessary but not sufficient. Public release requires a dedicated isolated backend, ordinary user authentication, durable private media storage, verified backups, hosted end-to-end tests, operational monitoring and explicit approval of recurring infrastructure/provider costs.

---

## Current evidence

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Source build | Passed on merged release candidates; main recheck running | PR #565 (TypeScript 7.0.2 + Vite 8.3.8) and PR #566 (stacked-PR CI coverage) passed exact-head build and release gates before merge. Main commit `6b21dc5` has a fresh post-merge quality run. |
| Latest deployment guard | Render deployment live; hosted acceptance incomplete | Render's production service reports commit `6b21dc5` live. Deployment success is not full hosted user-acceptance evidence. |
| Production-mode authentication | Code path implemented; hosted acceptance pending | Main includes Supabase password sign-in/recovery and server-managed opaque sessions. Production runtime configuration, a dedicated isolated Supabase project, RLS review and hosted owner/editor/viewer tests still require independent verification. |
| Isolated identity/database | Blocked | Connected Supabase projects already contain unrelated NEMA and shared platform tables. Do not reuse or migrate either for this application. Provision and review a dedicated project before applying the application schema. |
| Durable media storage | Cloud contracts implemented; production connection blocked | Private Supabase Storage adapter, owner-aware asset repository, streaming uploads, checksums, signed reads, soft-delete and lease-fenced derivative publication are implemented and CI-tested. Production still needs a dedicated isolated Supabase project, private bucket, active cloud API and hosted end-to-end validation. |
| Durable application database | Blocked for multi-instance use | The last verified production runtime uses SQLite on one persistent disk. A dedicated isolated Postgres project, schema/RLS review and durable queue migration are still required before horizontal scaling. |
| Worker recovery | Worker contracts implemented; live worker acceptance pending | Lease-fenced media/timeline workers, cancellation polling, recovery and derivative publication are tested. A separate production worker deployment and exact-host smoke tests remain unverified. |
| Media generation | Gated | Video AI upscaling is connected to the cloud media worker and has an isolated synthetic-video smoke-test command. The worker-side inference test has not yet been attested on the actual production worker; video flags remain false by default. Image/text/provider gateways remain gated. |
| Security review | Partial | API tests and headers exist. Complete Supabase RLS/storage policy review, auth abuse controls, upload isolation and dependency/security review are required on the dedicated project. |
| Recovery / backups | Blocked | No tested backup-and-restore procedure for the application's SQLite database and media files is recorded. |
| Operational monitoring | Blocked | No application-specific alerting, retention policy, capacity limits or tested incident/rollback procedure. |
| User acceptance | Not run | No hosted end-to-end tests with separate owner/editor/reviewer/viewer accounts and real media files. |

## Mandatory staging sequence

1. Create a dedicated isolated Supabase project for this application. Do not use the existing NEMA/shared-platform projects.
2. Review and apply only this application's migration to that isolated project. Verify RLS, grants, storage policies and security/performance advisors before connecting services.
3. Complete a normal user sign-in flow. Access tokens must never be requested from ordinary users as a manual setup step. Implement session refresh, logout, email confirmation/recovery and signup abuse controls.
4. Connect the application's active asset API and UI to private object storage. Verify authorization, checksum, byte limits, cleanup and signed-link expiry.
5. Choose a persistent runtime architecture. The current SQLite/local-media approach must remain single-instance with durable disk and tested backups; for horizontal scaling, complete the Postgres queue/data migration and deploy the worker.
6. Add resource limits for concurrent FFmpeg jobs, media duration, source size, output size and disk quota. A 1 GB disk is only a smoke-test/staging allocation, not a practical multi-user media library.
7. Run hosted smoke tests: registration/login, project isolation, role checks, upload/download, job queue, cancellation, media probe, derivative creation, review/approval, timeline render and logout/session expiry.
8. Perform a backup-and-restore rehearsal, check logs/metrics, test rollback and confirm a safe support/contact path.
9. Review the provider readiness catalog and costs. Keep paid generation disabled until each provider is priced, budgeted, approved and end-to-end tested.

## Deployment guardrails

- The Render Blueprint is staging-only and points to the feature branch. Do not retarget it to `main` until release approval.
- The blueprint requires `AUTH_MODE=supabase`, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Configure these only on the new isolated application service.
- The blueprint uses a persistent disk. Free ephemeral hosting is not suitable for user uploads or the SQLite database.
- Never copy service-role keys into the browser or into source control.
- Do not apply this project's migration to any existing shared Supabase database.
- Do not enable remote AI/image/video/speech providers without a price and approval gate.
- Keep original user media immutable; all edits create traceable derivatives.

## Evidence recorded on 14 November 2026

- Main commit: `6b21dc593be74bf2775a88b1bf7929a18a9b5346`.
- PR #563 merged the framewise video AI upscaling executor and lease-aware worker integration. Customer video jobs remain gated until the actual worker is verified.
- PR #564 added `npm run self-test:video-ai-upscale-worker`, which generates a synthetic four-frame clip, runs real NCNN/Vulkan inference on the worker and validates the resulting MP4. The command proves execution only; it does not certify visual quality or temporal consistency.
- PR #395 and PR #565 merged TypeScript 7.0.2 and Vite 8.3.8. Exact-head build, release, PostgreSQL, billing, financial, asset-publication, remediation and Google Drive checks passed.
- PR #566 expanded quality checks to stacked `feat/*`, `fix/*`, `integration/*`, `docs/*` and `ci/*` pull-request targets, and expanded Google Drive recovery checks to its provider stack. All exact-head checks passed.
- Render reported the production deployment for commit `6b21dc5` as live.
- No provider credentials, paid infrastructure, Supabase projects, production feature flags or external provider execution settings were changed by this work.

## Current video worker activation boundary

1. Install FFmpeg/FFprobe, the NCNN/Vulkan executable and selected model weights on the exact worker host.
2. Enable the image and video worker gates only for the isolated smoke test on that host, then run `npm run self-test:video-ai-upscale-worker`.
3. Review the real output and JSON report. Only after the smoke test passes may an operator set `AI_VIDEO_UPSCALE_WORKER_SELF_TEST_PASSED=true` on both API and worker.
4. Verify lease recovery, cancellation, audio/subtitle handling and derivative publication through the normal cloud queue. Temporal consistency remains uncertified and every output requires human quality review.
5. Keep customer-facing video inference disabled if private storage, durable database, worker capacity or any verification gate is missing.

## Stacked-branch integration finding

The quality and Google Drive workflows previously filtered pull requests to `main`, leaving intermediate feature/fix branches without equivalent checks. PR #566 corrects those event filters. It does not automatically rebase old branches or resolve source conflicts: each remaining stack must still be integrated bottom-up against current `main`, with current exact-head checks.

## Approval rule

A green GitHub build is necessary but not sufficient. Public release requires a dedicated isolated backend, ordinary user authentication, durable private media storage, verified backups, hosted end-to-end tests and an explicit owner approval of recurring infrastructure/provider costs.
