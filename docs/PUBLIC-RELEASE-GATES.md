# Public release gates

**Current decision: NOT APPROVED for public users.**  
**Scope:** isolated staging acceptance for Executive Visuals.  
**Last reviewed:** 8 November 2026. Current implementation branch: PR #240, feat/c2pa-protected-signing.

A green source build is necessary but not sufficient. This checklist records the actual boundary between implemented local capabilities and a hosted multi-user product.

## Current evidence

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Source build | Exact-head run pending | Workflow #8177 exposed a bootstrap SQL dollar-quoting typo; corrected. Run #8178 then passed bootstrap and lease-fencing PostgreSQL integration, but exposed a missing `derivative_of` column in the atomic-publication trigger setup; the migration now adds that lineage column before installing the trigger. Exact-head workflow #8180 is queued; do not mark this gate green until build, Docker and every PostgreSQL integration pass. |
| Deployment guard | Corrected; rerun required | Docker now pins both stages to patched Node 24.22.1 and checks the checksum-pinned CAI native binary. The deployment guard was updated to assert the pinned image. |
| Ordinary user authentication | Partially implemented | Supabase email/password registration and sign-in, email-confirmation response, HttpOnly access/refresh cookies, refresh-on-authentication and logout/revocation are implemented. Password recovery/reset UX, MFA/SSO and hosted acceptance are still open. |
| Isolated identity/database | Blocked | No dedicated application Supabase project has been provisioned and reviewed. Existing NEMA/shared-platform projects are out of scope and must not be reused. |
| Durable private media storage | Partial; staging gate blocked | The Runtime Asset Library now exposes a separate opt-in private cloud shelf for owner-scoped listing, streamed personal uploads and short-lived signed preview links when Supabase auth and `CLOUD_TIMELINE_API_ENABLED` are enabled. The default `/api/assets` processing lifecycle remains local SQLite/disk; cloud media processing and worker publication are not yet connected or deployed. Dedicated isolated Supabase migrations, private bucket/RLS review and staging acceptance remain mandatory. |
| Durable application database | Limited to single instance | Active local runtime uses SQLite. It is not a horizontally scalable multi-tenant data plane. Cloud Postgres migrations and queue adapters require a dedicated project and verified deployment wiring. |
| Worker recovery/publication | Implemented in feature branch; hosted gate blocked | Current PR #240 includes database-generated per-attempt fencing tokens, v2 queue RPCs, heartbeat drain, pre-publication checks, job-bound reservations, atomic asset+ledger finalization, unique attempt paths, same-tenant derivative validation and tombstone-claimed cleanup. PostgreSQL integration tests are added. Exact-head CI must pass; migrations are not applied to a dedicated Supabase project and no cloud worker is deployed. |
| Media generation | Explicitly limited | Local FFmpeg probe/edit/enhancement and timeline rendering work when binaries are installed. Image/video generation and advanced provider operations remain adapter-gated; no paid provider is enabled by default. |
| C2PA provenance | Implemented foundation; production signing disabled | Server-side CAI verification and Asset Library inspection are implemented. A protected callback signer and cloud media-worker hook exist, but no production KMS/HSM, certificate, TSA or trust-list policy is provisioned; local timeline/export signing remains incomplete. |
| Security review | Partial | Authenticated ownership checks, server-side credential boundaries, path validation, rate limiting and regression tests exist. Full RLS/storage-policy review, tenant route audit, upload isolation, dependency review and external security assessment remain required. |
| Recovery / backups | Blocked | No tested backup-and-restore rehearsal for the application database and media files is recorded. |
| Operational monitoring | Blocked | Application-specific alerting, retention, resource quotas, capacity monitoring and incident/rollback rehearsal are not accepted. |
| User acceptance | Not run | Hosted end-to-end tests with separate owner/editor/reviewer/viewer accounts, real media and recovery scenarios have not passed. |

## Mandatory staging sequence

1. Provision a dedicated isolated Supabase project for Executive Visuals. Do not reuse any NEMA or shared-platform project.
2. Review and apply only this application's migrations. Verify RLS, grants, private storage policies and database security/performance advisors before connecting services.
3. Complete ordinary account recovery: email/password registration and sign-in, email confirmation, refresh, logout, password-reset request and secure password update. Test expiry, replay, enumeration resistance and abuse controls.
4. Connect the active asset API and browser Asset Library to private object storage. Verify project/owner authorization, checksum, byte limits, range access, signed-link expiry, cleanup and derivative lineage.
5. Choose and prove the runtime architecture. SQLite/local media may be used only as a single-instance staging mode with persistent disk and tested backups. Horizontal scaling requires the Postgres data/queue path and deployed workers.
6. Port lease fencing and publication recovery to the current branch. Prove stale workers cannot publish after lease loss; duplicate attempts cannot create duplicate finalization; failed publication and cleanup reconcile deterministically.
7. Enforce limits for concurrent FFmpeg jobs, media duration, source/output size, disk quota and worker memory/CPU. A 1 GB disk is only a smoke-test allocation, not a multi-user media library.
8. Run hosted smoke tests for registration/login/recovery, project isolation, role checks, upload/download, job queue, cancellation, media probe, derivative creation, review/approval, timeline render, provenance inspection and logout/session expiry.
9. Perform a backup-and-restore rehearsal; verify monitoring, log redaction, rollback and support/contact procedures.
10. Review provider readiness and costs. Keep paid generation disabled until each provider is priced, budgeted, approved and end-to-end tested.

## Deployment guardrails

- The Render Blueprint is staging-only and points to the feature branch. Do not retarget it to `main` before release approval.
- Configure Supabase URL and publishable key only on the isolated application service. Never place service-role keys in browser code or source control.
- Do not apply this project's migrations to any existing shared Supabase database.
- Keep originals immutable; every transformation creates a traceable derivative.
- Keep production C2PA signing disabled until a reviewed KMS/HSM provider, certificate chain, TSA, trust/revocation policy and audit procedures are configured.
- Do not enable remote AI/image/video/speech providers without a verified price, explicit user approval and hard budget controls.
- Do not deploy production, change production credentials or run irreversible migrations as part of this staging work.

## Approval rule

Public release requires a green exact-head build, dedicated isolated backend, ordinary authentication and account recovery, private durable media storage, verified worker/publication recovery, backup restore, hosted end-to-end tests, monitoring and an explicit owner approval of recurring infrastructure/provider costs. A successful source build alone does not satisfy these gates.
