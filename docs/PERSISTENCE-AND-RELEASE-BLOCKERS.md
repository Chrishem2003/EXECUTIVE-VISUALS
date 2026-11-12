# Executive Visuals — persistence and release blockers

**Audit date:** 12 November 2026  
**Purpose:** Record the live infrastructure facts that prevent the hosted app from being certified as a durable, multi-user production system. This is an architecture decision record, not a claim that storage has been implemented.

## Observed infrastructure

| Resource | Observed state | Consequence |
|---|---|---|
| Render `executive-visuals` web service | Free plan, linked to `main`; no verified persistent disk | The Node service's local SQLite database and uploaded media are ephemeral. Render documents that Free web-service files are lost on restart, spin-down and deploy. |
| Cloudflare Worker `executive-visuals` (production edge) | Deployed; static `ASSETS` binding and API proxy to Render | It is not the D1 data plane and remains unchanged. |
| Cloudflare Worker `executive-visuals-d1-staging` | Separately deployed on workers.dev; D1 `DB` binding; restricted to auth/identity and `/api/d1/*`; business routes fail closed | Isolated staging metadata API exists. It is not yet the application's general API or production data plane. |
| Cloudflare D1 `executive-visuals-staging` | 126,976 bytes; migration `0001_initial.sql` recorded; seven `ev_*` tables; bound to the staging Worker; latest read-only audit found zero rows in all seven tables | Schema and staging repository/API are deployed. Authenticated browser round-trip through the Render same-origin bridge remains unverified; this is not yet the application's source of truth. |
| Cloudflare R2 | Not activated; listing buckets returns Cloudflare error 10042 asking to enable R2 in the dashboard | No durable object store is currently available for uploaded source media and rendered outputs. |
| Supabase organisation `Chrishem Autos` | Free plan; two existing projects already occupy the free-project allowance | Both existing projects contain NEMA/platform tables. They must not be repurposed for Executive Visuals or have their auth/storage settings changed for this app. |

## Current staging implementation boundary (12 November 2026)\n\nThe earlier 8 November observations that D1 had no tables or Worker binding are superseded. A read-only account query on 12 November confirmed all seven `ev_*` tables and zero user/project/membership/workspace/asset/job/audit rows. `wrangler.jsonc` targets only the separate `executive-visuals-d1-staging` Worker and the existing `executive-visuals-staging` database. The staging Worker authenticates by calling the existing Render `/api/me` endpoint and exposes only `/api/d1/*`; it does not proxy production project, asset, job, or media routes.\n\nThe repository contains an environment-gated same-origin `/api/d1/*` proxy controlled by `D1_STAGING_WORKER_URL`. It is fail-closed when unset. It has not been enabled on the live production Render service, and no isolated Render staging service has completed an authenticated browser workspace round-trip. Therefore D1 is a deployed staging foundation, not durable application persistence.\n\n## Recommended target architecture

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
- [ ] Complete authenticated browser round-trip through an isolated staging service and verify tenant isolation against live D1.
- [ ] R2 bucket is activated and created in Standard storage; private upload/download, multipart recovery, lifecycle and quota guardrails pass.
- [ ] Connect the full application project/workspace/asset/job APIs to D1 in staging; the current Worker exposes only project metadata and revisioned workspace documents.
- [ ] Render media execution is changed to use object storage for inputs/outputs and scratch-only local files.
- [ ] Restart/redeploy recovery, backup/export/restore and cross-account isolation tests pass.
- [ ] Browser/mobile acceptance and independent security review pass before production claims.

## Safety decisions

- No existing Supabase project was modified.
- No R2 subscription was activated and no bucket was created.
- The isolated staging D1 schema and staging Worker binding are deployed; no production D1 binding or route was changed.
- No paid Render plan, persistent disk, Render Postgres or production deployment was added.
- The current app must continue to display its temporary-storage warning until the end-to-end persistence gates pass.
