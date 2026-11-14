# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Scope:** staging deployment review for the unified production application.  
**Last reviewed:** 14 November 2026.

# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Scope:** staging deployment review for the unified production application.  
**Last reviewed:** 15 November 2026.

## Mainline reconciliation — 15 November 2026 (supersedes all earlier checkpoints below)

- **Current GitHub main:** `2d0c8ec9497b20db3efad908b7bf7eacfa2ebcbf`.
- **Production deployment:** Render's `EXECUTIVE-VISUALS` service reports this exact commit as `live` at `https://executive-visuals.onrender.com`. The service is on Render Free in Frankfurt; this confirms source deployment, not hosted customer acceptance or durable media readiness.
- **Merged PR #591:** verification pipeline improvements and separated product build/verification batches.
- **Merged PR #592:** Paddle primary and Pesapal secondary provider adapters, unified subscription orchestration, authenticated checkout, verified webhook/IPN settlement, Paddle recurring renewals and customer portal cancellation/payment-method management. Paddle adjustment events are preserved for financial review; they are not automatically executed as refunds. Pesapal currently supports one-time checkout and authenticated manual renewal only; automatic Pesapal recurring schedules are not implemented.
- **Merged PR #593:** private Gemini Files upload, durable upload-attempt tracking, recovery leases and retention workers. Gemini temporary files do not replace the application's private customer-media store.
- **Billing activation boundary:** provider integration code is merged, but checkout remains disabled by default. Isolated PostgreSQL migration validation, actual Paddle/Pesapal sandbox credentials and merchant end-to-end acceptance are still required. Never enable live checkout without explicit merchant approval.
- **Open PR #594:** Google Omni worker integration. Exact-head release integration and build jobs have passed; cloud-video PostgreSQL and asset-publication PostgreSQL tests have passed; multiple product-verification batches are still running/queued, while some unrelated billing and Drive checks are still running. Hosted D1 acceptance jobs were skipped, not passed. Do not merge until all required exact-head checks complete successfully.
- **Google model compatibility:** PR #594 currently pins `gemini-omni-1.1-flash`, uses 1.1 token rates and limits output to 10 seconds. Google announced Omni 1.2 Flash GA on 5 November 2026 with up to 15-second clips and a published 720p price of $0.07/second. The PR must explicitly scope 1.1 or add a separately priced and tested 1.2 path. Do not change only the model string or infer hosted readiness from CI.
- **Hosted persistence remains the critical release blocker:** no dedicated isolated Executive Visuals Supabase project, production private object bucket, verified hosted RLS/storage policy, separately accepted durable worker, tested backups or role-based hosted acceptance is established. Do not reuse NEMA/shared-platform Supabase projects.
- **Upload behavior remains fail-closed:** do not weaken production upload guards while durable private storage is unavailable. R2 is optional source code only; no R2 bucket or credentials have been provisioned.
- **Stale integration branches:** PR #206 remains a large divergent branch and must not be merged wholesale. PR #303 is stacked on that branch; review only for capabilities not already covered by #592. PRs #294 and #297 are superseded by the quality-assessment and FlashVSR mainline work.
- **No production credentials, migrations, paid infrastructure, provider execution or service configuration were changed by this reconciliation.**

## Current priority order

1. Complete PR #594's exact-head quality/product/PostgreSQL checks and reconcile the Google model/pricing target before merge.
2. Validate the Paddle/Pesapal migration and both sandbox flows against a dedicated isolated staging database and merchant accounts; keep production billing disabled.
3. Provision a dedicated Executive Visuals identity/database and private media storage; review RLS, grants, bucket policies and signed URL expiry.
4. Deploy and verify the API and durable worker against that isolated backend; test lease recovery, cancellation, media ingestion and delivery.
5. Verify owner/editor/reviewer/viewer access, backup/restore, monitoring, incident response and rollback on the hosted environment.
6. Only then consider public release and any paid provider/hosting activation.

## Evidence and release rule

A successful source build, CI suite or GitHub merge is necessary but not sufficient. Public release requires a dedicated isolated backend, ordinary user authentication, durable private media storage, verified backups, hosted end-to-end tests, operational monitoring and explicit approval of recurring infrastructure/provider costs.

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
