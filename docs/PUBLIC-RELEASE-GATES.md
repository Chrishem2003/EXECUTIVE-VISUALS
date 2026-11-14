# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Last reviewed:** 15 November 2026.  
**Current main:** `baf834a29a3b4f6fd2612ffd2cb1994ac2e80789`.

## Verified deployment

- Render production service `EXECUTIVE-VISUALS` is `live` on the exact current main commit above.
- Production URL: https://executive-visuals.onrender.com
- Render plan: Free, Frankfurt.
- Build and deploy events both report success.
- The runtime started `node server/index.mjs`; startup logs show Node's experimental SQLite warning.
- The latest build emitted a 784.39 kB JavaScript entry bundle and a 119.88 kB CSS bundle. Vite/Rolldown warned that the JavaScript chunk exceeds 500 kB; treat this as a frontend performance/refactoring item, not a failed build.

## Isolated Cloudflare D1 staging — verified 15 November 2026

- The existing Cloudflare D1 database `executive-visuals-staging` is already provisioned; do not create a duplicate.
- Migration `0001_initial.sql` is recorded in `d1_migrations`. The expected `ev_users`, `ev_projects`, `ev_project_members`, `ev_project_workspace_documents`, `ev_assets`, `ev_jobs` and `ev_audit_events` tables, indexes and ownership triggers are present.
- Read-only live integrity checks returned `PRAGMA quick_check = ok`, no foreign-key violations, no projects missing workspace documents, and no orphaned assets/jobs.
- The Cloudflare Worker `executive-visuals-d1-staging` exists, and the Render staging app `EXECUTIVE-VISUALS-1` has a live deployment. PR #499's Release Integration Gate completed both `full-build-and-verification` and `isolated-d1-staging-live-acceptance` successfully.
- This is an isolated metadata/workspace staging path, not production persistence. D1's schema permits `local-staging` assets; R2 is disabled. The D1 worker uses an allowlisted staging-only local identity path; this must never be copied to production.
- No D1 rows or schema were changed during this review.

### Free-tier capacity and limits

- Supabase Free allows two free projects across organizations where the account is an owner/administrator. Both currently connected Supabase projects are already active; do not create a third project, repurpose either existing project, or upgrade the organization without an explicit cost decision.
- Cloudflare D1 on Workers Free includes 5 million rows read/day, 100,000 rows written/day and 5 GB total database storage. Workers Free includes 100,000 requests/day and 10 ms CPU per invocation. These limits suit a small metadata staging workload, not FFmpeg rendering or long-running video generation.
- Keep large media in private object storage. R2 remains unprovisioned/deferred; no card, billing setting or paid plan was changed.

## Mainline integrations now deployed

- **PR #591:** bounded product-verification batches and CI improvements.
- **PR #592:** Paddle primary and Pesapal secondary subscription integration. Paddle recurring lifecycle and customer self-service cancellation/payment-method portal are implemented. Pesapal supports one-time checkout and authenticated manual renewal; automatic recurring schedules are not implemented. Provider checkout remains gated pending isolated database migrations, merchant sandbox credentials and end-to-end acceptance.
- **PR #593:** private Gemini Files upload, durable upload-attempt tracking, recovery leases and retention workers. Temporary Gemini Files are not the application's permanent media store.
- **PR #594:** Google Omni worker composition, approval and budget checks, private input planning, interaction ownership, provider routing, UI readiness and cost reconciliation. Its exact-head CI passed before merge. All remote execution gates remain opt-in and false by default in the checked-in example configuration.
- **PR #595:** closed as superseded by #594; do not merge the older overlapping worker bootstrap.
- **PR #596:** release-readiness reconciliation documentation.

## Hosted runtime blockers

1. **Database and identity:** production health implementation reports SQLite/local-disk storage. No dedicated isolated Executive Visuals Supabase project has been provisioned. The two connected Supabase projects are used by NEMA/shared platform workloads and must not be repurposed.
2. **Private media:** the private `executive-visuals-media` bucket and reviewed storage/RLS policies are not confirmed in an isolated application project. Keep hosted customer uploads fail-closed.
3. **Worker:** the Render workspace currently has the production web service and an older staging web service, but no separately provisioned cloud background worker. The worker entrypoint exists as `npm run start:cloud-worker`; it must not be enabled inside the web process as a substitute for an independently deployed worker.
4. **Google Drive:** implementation exists but remains opt-in until Supabase Auth, reviewed migrations, private bucket, OAuth client, redirect URI and separate encryption keys are configured and tested.
5. **Subscriptions:** provider adapters are in main, but merchant sandbox acceptance and production webhook verification remain outstanding. Do not enable live checkout or claim recurring Pesapal support.
6. **Provider generation:** Gemini/Runway/FAL remote execution requires explicit provider credentials, paid-tier confirmation, approved cost reservation, private storage and the independent worker. No generation flag should be enabled merely because the UI exposes a model option.
7. **Durability and operations:** backup/restore, hosted role isolation, signed URL expiry, queue recovery, monitoring and incident/rollback drills remain unaccepted.

## Current next steps

1. Extend the already-provisioned isolated D1 staging path only where the current schema/workspace acceptance tests prove the need; do not create another database or mutate existing production resources.
2. Keep D1 as staging metadata only until identity, storage, backup/restore, rate limits and production operational requirements are designed and accepted. Do not port the staging-only local-auth allowlist to production.
3. Resolve private durable media storage separately. R2 remains deferred; no large customer upload may fall back to ephemeral Render disk.
4. Verify Google Drive OAuth/import/export and Paddle/Pesapal sandbox lifecycle against an isolated, persistent backend. Keep provider and payment gates disabled until verified.
5. Refactor the 415 kB source entry module into feature modules and reduce the 784 kB emitted JavaScript entry bundle; preserve application behavior and add build-size regression checks.
6. Complete hosted end-to-end tests, backup/restore and security review before public release.

## Release rule

A green build, successful deployment or merged PR does not prove hosted customer acceptance. Public release requires dedicated isolated identity/database, durable private media storage, independent workers, tested backups, hosted end-to-end workflows, operational monitoring and explicit approval of recurring infrastructure/provider costs.

---

## Historical reconciliation — 14 November 2026 (superseded by the 15 November checkpoint above)

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
| Source build | Latest mainline integrations merged; PR #594 checks partially complete | PRs #591–#593 are merged. PR #594 has successful build, release integration and cloud-video PostgreSQL checks; remaining exact-head product batches are still pending. |
| Latest deployment | Live on current main | Render production reports commit `2d0c8ec9497b20db3efad908b7bf7eacfa2ebcbf` as live. This is deployment evidence, not full hosted acceptance. |
| Production authentication | Pending hosted acceptance | Supabase auth/session code exists, but the dedicated application project, production configuration, RLS review and owner/editor/reviewer/viewer hosted tests are not verified. |
| Isolated identity/database | Blocked | Connected Supabase projects contain unrelated NEMA/shared-platform data. Provision a dedicated Executive Visuals project; do not reuse existing projects. |
| Durable media storage | Contracts implemented; production connection blocked | Private Supabase Storage and optional R2 adapter code exist. No dedicated production bucket, credentials, policy review or hosted media lifecycle acceptance is established. |
| Durable application database | Blocked for multi-instance use | The last verified production runtime uses SQLite/local disk. Complete isolated Postgres setup and queue/data migration before horizontal scaling; otherwise preserve single-instance constraints and tested backups. |
| Worker recovery | Code implemented; live acceptance pending | Lease-fenced worker, cancellation and publication contracts exist. A separately deployed/verified production worker and exact-host recovery tests remain outstanding. |
| Media generation | Gated | Framewise and FlashVSR paths exist, but worker-side execution and quality attestations are not established on the live host. Provider gateways remain default-off. |
| Billing and subscriptions | Provider adapters merged; hosted acceptance pending | PR #592 adds Paddle recurring lifecycle and customer portal controls plus Pesapal one-time/manual renewal. Sandbox credentials, isolated migration validation and end-to-end merchant tests remain outstanding; automatic Pesapal recurring is not implemented. |
| Security review | Partial | API tests and fail-closed guards exist. Complete hosted RLS/storage-policy review, upload isolation and dependency/security review remain outstanding. |
| Recovery / backups | Blocked | No tested backup-and-restore rehearsal for the live application database and customer media is recorded. |
| Operational monitoring | Blocked | Application-specific alerting, retention, capacity limits, incident response and rollback rehearsal are not verified. |
| User acceptance | Not run | Hosted end-to-end tests with separate roles and real media have not been recorded. |

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

- Current GitHub main is `4221ec5b464820bdd3df1d1ab152cf26bc1fd098`, the FlashVSR temporal enhancement merge (PR #588).
- PRs #567–#588 delivered the focused source and UI slices listed in the mainline reconciliation section above. These merges do not prove the Render deployment has advanced from the last documented live commit `6b21dc5`.
- PR #578 adds an optional private R2 adapter; no R2 bucket, credentials or paid infrastructure were provisioned as part of this audit.
- PR #587 adds offline paired-reference/visual-quality assessment; it does not make AI enhancement automatically quality-approved.
- PR #588 adds the gated FlashVSR v1.1 temporal path. It remains unavailable on Render Free without an isolated compatible CUDA worker, upstream checkout, model weights, real inference self-test and separate quality-evidence attestation.
- PRs #570–#572 intentionally prevent uploads from being treated as durable when production storage is ephemeral or not verified. Do not remove those guards.
- PR #206 remains a stale, divergent source branch. PR #303 remains stacked on it. Neither is safe to merge wholesale.
- No production configuration, provider credentials, migrations, paid infrastructure, provider execution or deployment was changed by this reconciliation.

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
