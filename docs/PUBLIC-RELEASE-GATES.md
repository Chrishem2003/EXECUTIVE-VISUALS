# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Scope:** staging deployment review for the unified production application.  
**Last reviewed:** 3 November 2026.

This checklist separates a successful source build from a safe, usable hosted service. Do not promote the feature branch to the production branch or expose the application to public users until every mandatory gate below has evidence.

## Current evidence

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Source build | Passed on the last completed quality workflow | Workflow 1692 completed successfully: dependency install, TypeScript check and full build. |
| Latest deployment guard | Running | Workflow 1696 includes the new checks that reject development-only authentication in the Render production-mode blueprint. |
| Production-mode authentication | Native flow implemented in isolated feature branch; CI and hosted verification pending | Added email/password sign-in and signup through the Supabase Auth server proxy, HttpOnly refresh-token cookie, access-token renewal, logout, recovery email initiation and recovery-password update. Added bounded per-email auth attempt budgets and timeout-bounded access-token verification. Browser no longer needs a pasted access token. Configure `SUPABASE_AUTH_REDIRECT_URL`; verify email-confirmation and recovery redirects on the dedicated staging project, then run separate-account browser tests. CAPTCHA/Turnstile and distributed rate limiting remain open. |
| Isolated identity/database | Blocked | Connected Supabase projects already contain unrelated NEMA and shared platform tables. Do not reuse or migrate either for this application. Provision and review a dedicated project before applying the application schema. |
| Durable media storage | Asset API, browser workspace and authenticated cloud media-job enqueue bridge implemented behind opt-in flag; hosted worker execution remains unverified | The asset workspace switches uploads, listings and previews to authenticated `/api/cloud/assets` routes when enabled/configured. Preview uses an authenticated redirect to a five-minute signed URL. An authenticated `/api/cloud/media-jobs` route now pins the verified source SHA-256 and enqueues into the Postgres queue consumed by the separate cloud media worker. The browser routes cloud-backed media actions to the cloud queue when both flags are ready and shows local/cloud job provenance in one history. Authorized project editors can atomically cancel queued jobs or request cooperative cancellation of running jobs. Running workers poll cancellation under their active lease; finish and retry RPCs give accepted cancellation precedence over success/retry races. Hosted worker acceptance remains open. Apply and verify the isolated Supabase migration/bucket before enabling cloud mode. |
| Durable application database | Blocked for multi-instance use | Current runtime uses SQLite on one persistent disk. It is a single-instance staging architecture, not a horizontally scalable multi-tenant deployment. |
| Worker recovery | Partial | Local queue leases/retries exist. Cloud worker cancellation polling, cancellation-aware expired-lease recovery, and lease-fenced completion are implemented in code, but the cloud worker process is not deployed or connected to the active application queue. |
| Media generation | Explicitly limited | Local FFmpeg editing/enhancement is implemented. Actual image/video generation and verified neural super-resolution are not generally available; provider adapters remain gated. |
| Security review | Partial | API tests and headers exist. Complete Supabase RLS/storage policy review, auth abuse controls, upload isolation and dependency/security review are required on the dedicated project. |
| Recovery / backups | Blocked | No tested backup-and-restore procedure for the application's SQLite database and media files is recorded. |
| Operational monitoring | Blocked | No application-specific alerting, retention policy, capacity limits or tested incident/rollback procedure. |
| User acceptance | Not run | No hosted end-to-end tests with separate owner/editor/reviewer/viewer accounts and real media files. |

## Mandatory staging sequence

1. Create a dedicated isolated Supabase project for this application. Do not use the existing NEMA/shared-platform projects.
2. Review and apply only this application's migration to that isolated project. Verify RLS, grants, storage policies and security/performance advisors before connecting services.
3. Complete a normal user sign-in flow. Access tokens must never be requested from ordinary users as a manual setup step. Implement session refresh, logout, email confirmation/recovery and signup abuse controls.
4. Verify the opt-in `/api/cloud/assets` bridge and cloud-backed browser asset workspace against the dedicated private bucket. Deploy the isolated cloud worker with `CLOUD_WORKER_ENABLED=true` and the required media-family flag only after FFmpeg, database functions and private storage are ready. Apply and verify the queued and cooperative cloud-cancellation RPC migrations in the isolated project. Verify authenticated cloud media-job enqueue and project-wide job visibility, atomic queued cancellation versus worker claims, running cancellation request/poll/abort/terminal transitions under an unexpired lease, cancellation races with success and retry, durable job-event history, worker claim/lease/recovery, pinned source checksum enforcement, cloud source download, derivative publication, authorization, byte limits, cleanup, preview redirects and signed-link expiry. Confirm a cancellation request cannot affect another project or a replacement worker lease.
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

## Approval rule

A green GitHub build is necessary but not sufficient. Public release requires a dedicated isolated backend, ordinary user authentication, durable private media storage, verified backups, hosted end-to-end tests and an explicit owner approval of recurring infrastructure/provider costs.
