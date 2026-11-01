# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Scope:** staging deployment review for the unified production application.  
**Last reviewed:** 1 November 2026.

This checklist separates a successful source build from a safe, usable hosted service. Do not promote the feature branch to the production branch or expose the application to public users until every mandatory gate below has evidence.

## Current evidence

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Source build | Passed on the last completed quality workflow | Workflow 1692 completed successfully: dependency install, TypeScript check and full build. |
| Latest deployment guard | Running | Workflow 1696 includes the new checks that reject development-only authentication in the Render production-mode blueprint. |
| Production-mode authentication | Blueprint corrected; user flow incomplete | Render blueprint now requires Supabase auth and non-synchronized secret inputs. Browser gate still asks users to paste an access token; implement email/password or passwordless sign-in, refresh, logout and account recovery before beta. |
| Isolated identity/database | Blocked | Connected Supabase projects already contain unrelated NEMA and shared platform tables. Do not reuse or migrate either for this application. Provision and review a dedicated project before applying the application schema. |
| Durable media storage | Blocked | Current active API uses SQLite and a local media directory. Cloud object-storage adapter is not integrated into the main asset API/UI. |
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

## Approval rule

A green GitHub build is necessary but not sufficient. Public release requires a dedicated isolated backend, ordinary user authentication, durable private media storage, verified backups, hosted end-to-end tests and an explicit owner approval of recurring infrastructure/provider costs.
