# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Scope:** staging deployment review for the unified production application.  
**Last reviewed:** 5 November 2026.

This checklist separates a successful source build from a safe, usable hosted service. Do not promote the feature branch to the production branch or expose the application to public users until every mandatory gate below has evidence.

## Current evidence

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Source build | Passed on PR #97 | Quality workflow #6172 completed successfully, including dependency installation, TypeScript typecheck and the full production build. PR #97 remains draft and unmerged. |
| Latest deployment guard | Not re-verified in this review | The deployment guard must be checked on the current staging deployment commit before any promotion. A historical green workflow is not current deployment evidence. |
| Production-mode authentication | Blueprint corrected; user flow incomplete | Render blueprint now requires Supabase auth and non-synchronized secret inputs. Browser gate still asks users to paste an access token; implement email/password or passwordless sign-in, refresh, logout and account recovery before beta. |
| GCS workload identity | Focused CI passed; live identity not verified | PR #96 GCS identity workflow #21 passed 104/104 tests and PostgreSQL integration #2430 passed. PR #93 follow-up workflow #23 passed 103/103 tests and PostgreSQL integration #2431 passed. These are isolated CI tests only; no live Google Cloud workload identity, bucket IAM or upload/recovery test has been run. |
| Isolated identity/database | Blocked | Connected Supabase projects already contain unrelated NEMA and shared platform tables. Do not reuse or migrate either for this application. Provision and review a dedicated project before applying the application schema. |
| Durable media storage | Implemented as an opt-in boundary; active library still local | Private Supabase Storage adapter, owner-aware cloud asset repository, streaming upload, SHA-256 receipts, signed reads, soft-delete and authenticated `/api/cloud/assets` routes exist and are contract-tested. The separate Cloud workspace can upload/list/read assets, but the primary Asset Library and local `/api/assets` lifecycle still use local disk. `CLOUD_TIMELINE_API_ENABLED` defaults off; staging has not been connected to a dedicated project. |
| Durable application database | Blocked for multi-instance use | Current runtime uses SQLite on one persistent disk. It is a single-instance staging architecture, not a horizontally scalable multi-tenant deployment. |
| Worker recovery | Partial | Local queue leases/retries exist. Cloud worker process is not deployed or connected to the active application queue. |
| Media generation | Explicitly limited | Local FFmpeg editing/enhancement is implemented. Actual image/video generation and verified neural super-resolution are not generally available; provider adapters remain gated. |
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


## Evidence recorded on 5 November 2026

- PR #97 Quality checks run #6172: successful full build on commit `75c9ae3e43f3a179da12a1b0b7881f8e9bdae257`.
- PR #96 GCS identity regression run #21: 104 tests passed, 0 failed on commit `6092906689a57956f6e3fdfacdd0dfa63141f75a`.
- PR #96 cloud video PostgreSQL integration run #2430: all schema, privilege, lease-integrity and concurrent enqueue checks completed successfully.
- PR #93 GCS identity regression run #23: 103 tests passed, 0 failed on commit `8974afcdb9170085ce8d8cdcb3c13747c5882a27` after correcting the lookalike-constructor fixture.
- PR #93 cloud video PostgreSQL integration run #2431: all steps completed successfully.
- PRs #93, #96 and #97 remain drafts and unmerged. CI evidence does not mean the live staging services have been provisioned or tested.

## Exact remaining cloud acceptance boundary

The opt-in cloud asset API checks the required `executive_visuals` tables and verifies that the `executive-visuals-media` bucket reports `public=false` at startup. The current Render Blueprint does not enable `CLOUD_TIMELINE_API_ENABLED` or configure server-side service-role credentials, and no dedicated isolated Supabase project has been approved or connected. Do not enable the flag against an existing NEMA or shared-platform project.

The next implementation slice is to complete ordinary Supabase sign-in/session lifecycle, provision and review a dedicated isolated project only after approval, then connect the private cloud asset lifecycle to the primary Asset Library. Keep local SQLite/media mode as the safe default until the cloud path passes hosted end-to-end tests.

## Approval rule

A green GitHub build is necessary but not sufficient. Public release requires a dedicated isolated backend, ordinary user authentication, durable private media storage, verified backups, hosted end-to-end tests and an explicit owner approval of recurring infrastructure/provider costs.
