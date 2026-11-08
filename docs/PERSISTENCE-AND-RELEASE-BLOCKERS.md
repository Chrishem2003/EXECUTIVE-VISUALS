# Executive Visuals — persistence and release blockers

**Audit date:** 8 November 2026  
**Purpose:** Record the live infrastructure facts that prevent the hosted app from being certified as a durable, multi-user production system. This is an architecture decision record, not a claim that storage has been implemented.

## Observed infrastructure

| Resource | Observed state | Consequence |
|---|---|---|
| Render `executive-visuals` web service | Free plan, linked to `main`; no verified persistent disk | The Node service's local SQLite database and uploaded media are ephemeral. Render documents that Free web-service files are lost on restart, spin-down and deploy. |
| Cloudflare Worker `executive-visuals` | Deployed; currently has only an `ASSETS` binding and proxies `/api/*` to the Render API | It is an edge/static-asset proxy, not the application's durable API/database layer. |
| Cloudflare D1 `executive-visuals-staging` | Exists in the Cloudflare account; 12 KiB initial file, zero application tables | A suitable isolated staging metadata database is available, but no Worker binding or application migration is connected yet. |
| Cloudflare R2 | Not activated; listing buckets returns Cloudflare error 10042 asking to enable R2 in the dashboard | No durable object store is currently available for uploaded source media and rendered outputs. |
| Supabase organisation `Chrishem Autos` | Free plan; two existing projects already occupy the free-project allowance | Both existing projects contain NEMA/platform tables. They must not be repurposed for Executive Visuals or have their auth/storage settings changed for this app. |

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
- [ ] D1 schema and Worker binding are implemented on `executive-visuals-staging`; tenant-isolation and migration tests pass.
- [ ] R2 bucket is activated and created in Standard storage; private upload/download, multipart recovery, lifecycle and quota guardrails pass.
- [ ] Render media execution is changed to use object storage for inputs/outputs and scratch-only local files.
- [ ] Restart/redeploy recovery, backup/export/restore and cross-account isolation tests pass.
- [ ] Browser/mobile acceptance and independent security review pass before production claims.

## Safety decisions

- No existing Supabase project was modified.
- No R2 subscription was activated and no bucket was created.
- No D1 schema was applied and no Worker binding was changed.
- No paid Render plan, persistent disk, Render Postgres or production deployment was added.
- The current app must continue to display its temporary-storage warning until the end-to-end persistence gates pass.
