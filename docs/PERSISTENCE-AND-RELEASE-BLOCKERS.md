# Executive Visuals — persistence and release blockers

**Audit date:** 13 November 2026  
**Purpose:** Record the live infrastructure facts that prevent the hosted app from being certified as a durable, multi-user production system. This is an architecture decision record, not a claim that storage has been implemented.

## Observed infrastructure

| Resource | Observed state | Consequence |
|---|---|---|
| Render `executive-visuals` web service | Free plan, linked to `main`; no verified persistent disk | The Node service's local SQLite database and uploaded media are ephemeral. Render documents that Free web-service files are lost on restart, spin-down and deploy. |
| Cloudflare Worker `executive-visuals` (production edge) | Deployed; static `ASSETS` binding and API proxy to Render | It is not the D1 data plane and remains unchanged. |
| Cloudflare Worker `executive-visuals-d1-staging` | Separately deployed on workers.dev; D1 `DB` binding; restricted to auth/identity and `/api/d1/*`; business routes fail closed | Isolated staging metadata API exists. It is not yet the application's general API or production data plane. |
| Cloudflare D1 `executive-visuals-staging` | 126,976 bytes; migration `0001_initial.sql` recorded; seven `ev_*` tables; bound only to the staging Worker; authenticated acceptance created one smoke user, one project and one workspace document; no assets/jobs/audit events | Authenticated project create/list and revisioned workspace save/reload are verified through the staging same-origin bridge. This remains isolated staging metadata, not the production source of truth. |
| Cloudflare R2 | Not activated; listing buckets returns Cloudflare error 10042 asking to enable R2 in the dashboard | No durable object store is currently available for uploaded source media and rendered outputs. |
| Supabase organisation `Chrishem Autos` | Free plan; two existing projects already occupy the free-project allowance | Both existing projects contain NEMA/platform tables. They must not be repurposed for Executive Visuals or have their auth/storage settings changed for this app. |

## Current staging implementation boundary (13 November 2026)

The earlier 8 November observations that D1 had no tables or Worker binding are superseded. A read-only schema query confirms all seven `ev_*` tables and migration `0001_initial.sql`. On 13 November, the live acceptance workflow registered/authenticated the allowlisted staging smoke identity, verified `/api/me`, created and listed a project through the Render same-origin `/api/d1/*` bridge, saved a workspace document from revision 1 to revision 2, reloaded it with exact document equality, and confirmed anonymous project access returns HTTP 401. A subsequent read-only D1 query confirmed three staging smoke users, three projects and three workspace documents; memberships, assets, jobs and audit events remain zero.

The staging Worker authenticates against the dedicated Render staging API and exposes only `/api/d1/*`; it does not proxy production project, asset, job, or media routes. The bridge is configured only on the isolated staging service. Production health continues to report Supabase auth and `d1WorkspaceEnabled=false`. D1 is now an accepted staging workspace foundation, but it is not the production source of truth or a complete media-storage solution. Staging identity currently uses local SQLite on Render's unverified/ephemeral disk, so the smoke account is not a durable customer identity.

## Recommended target architecture

1. **Cloudflare D1** — durable relational metadata for accounts/workspace mapping, projects, memberships, assets, jobs, reviews, audit records and provenance indexes. Use parameterized SQL, indexed tenant-scoped queries and server-side authorization. Keep the existing staging database isolated.
2. **Cloudflare R2 Standard** — durable private source media, derivatives, timeline renders, thumbnails and export artifacts. Use object keys scoped by account/project, server-authorized reads, short-lived signed URLs or a Worker-mediated access path, checksums, lifecycle rules and upload recovery.
3. **Cloudflare Worker** — authenticated API boundary with D1 and R2 bindings. Do not expose D1 or R2 credentials to the browser. Preserve the current Render service as a media-processing execution target until media jobs can be moved or safely orchestrated elsewhere.
4. **Render media processor** — use local filesystem only as temporary scratch space. Download inputs from durable object storage, run FFmpeg/AI tasks, upload verified outputs back to R2, then persist job results and provenance to D1. A worker restart must not destroy the only copy of an asset.
5. **Dedicated identity provider** — do not reuse either existing Supabase project because both contain NEMA/platform data. Choose an app-specific identity project/provider and keep credentials server-side. The password recovery implementation in PR #251 depends on a configured Supabase Auth project and an exact redirect allowlist.

## Free-tier and billing boundary

- Cloudflare D1 is available on Workers Free. Current published limits include 5 million rows read/day, 100,000 rows written/day, 5 GB total storage across the account, 500 MB per Free database and 7-day Time Travel. The existing staging database is empty, so a schema can be built and tested without touching another product.
- Cloudflare R2 Standard currently includes 10 GB-month storage, 1 million Class A operations and 10 million Class B operations per month, with no egress charge. Usage above the free allowance is billed. R2 activation requires completing the dashboard subscription/checkout flow; it has not been activated here.
- Cloudflare Email Sending is not available on Workers Free; arbitrary-recipient outbound email requires Workers Paid. Free Email Routing is inbound/forwarding only and cannot replace transactional password-reset email. No paid email plan was enabled.
- Render Free web services have ephemeral filesystems and cannot attach persistent disks. Render Free Postgres expires after 30 days, so it is not a suitable durable production datastore.
- Supabase Free allows two active projects across organisations for an owner/admin. The two current projects are already used by other platform work.

## Release gates

- [ ] User explicitly approves activating Cloudflare R2 after reviewing the free allowance and overage billing risk, or selects another durable object-storage provider.
- [ ] Dedicated Executive Visuals identity provider is selected and its public redirect URL/email-delivery settings are configured without changing NEMA projects.
- [x] D1 schema and Worker binding are implemented on `executive-visuals-staging`; local migration/repository/Worker tests pass.
- [x] Complete authenticated project create/list and revisioned workspace save/reload through the isolated staging same-origin bridge; anonymous project access is rejected.\n- [x] Complete live cross-account owner-isolation tests with two independently authenticated identities: cross-account listing, project reads, workspace reads and workspace writes are rejected; each account can access its own project.\n- [ ] Complete shared-member role matrix tests (owner/editor/reviewer/viewer) against live D1.
- [ ] R2 bucket is activated and created in Standard storage; private upload/download, multipart recovery, lifecycle and quota guardrails pass.
- [ ] Connect the full application project/workspace/asset/job APIs to D1 in staging; the current Worker exposes only project metadata and revisioned workspace documents.
- [ ] Render media execution is changed to use object storage for inputs/outputs and scratch-only local files.
- [ ] Restart/redeploy recovery, backup/export/restore and cross-account isolation tests pass.
- [ ] Browser/mobile acceptance and independent security review pass before production claims.

## Safety decisions

- No existing Supabase project was modified.
- No R2 subscription was activated and no bucket was created.
- The isolated staging D1 schema and staging Worker binding are deployed; no production D1 binding or route was enabled.
- The main-branch merge triggered the existing Render production auto-deploy; production health continues to show Supabase auth and D1 staging disabled. No production environment configuration or database was changed.
- No paid Render plan, persistent disk, Render Postgres or paid service was added.
- The current app must continue to display its temporary-storage warning until durable database/object storage and backup/restore gates pass.
