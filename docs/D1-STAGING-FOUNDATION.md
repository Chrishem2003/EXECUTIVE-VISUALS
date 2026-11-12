# Cloudflare D1 staging foundation

**Status (12 November 2026):** isolated D1 schema and Worker are deployed and read-only health checks pass. The current-main same-origin proxy and its authenticated-cookie regression test are merged. The proxy is not enabled in production; no authenticated browser workspace round-trip has been performed.

## Boundary and identity

The D1 database is only for Executive Visuals staging. The adapter expects an identity that has already been authenticated by the existing API/identity provider. It maps the verified provider subject to an internal D1 principal; it does not validate JWTs, store passwords, or accept a browser-supplied owner ID as proof of identity.

The schema stores metadata only. It does not store media bytes, provider secrets, access/refresh tokens, password hashes, or public media URLs. Asset rows contain private storage keys and checksums. R2 remains disabled until the user explicitly approves its dashboard activation and any overage billing risk.

## Files

- `migrations/d1/0001_initial.sql`: SQLite-compatible D1 schema for principal mapping, projects, memberships, workspace documents, asset metadata/provenance, job metadata and audit events.
- `server/d1-repository.mjs`: parameterized D1 repository. Project reads are scoped to owner/member; writes enforce owner/editor roles and optimistic revisions.
- `server/tests/d1-repository.test.mjs`: local in-memory SQLite tests using the same SQL migration. No remote D1 binding is used.
- `cloudflare/worker.mjs`: separate staging Worker that exposes isolated `/api/d1/*` endpoints and proxies only login/logout plus the authenticated `/api/me` identity check. All other production business API routes are blocked.
- `server/index.mjs`: an environment-gated same-origin `/api/d1/*` proxy. It requires the existing application session, forwards only the session cookie/Bearer header and bounded JSON body, and is disabled unless `D1_STAGING_WORKER_URL` is explicitly configured. Production remains unchanged while that variable is absent.
- `cloudflare/worker.test.mjs`: Worker tests for schema readiness, upstream authentication, project creation/listing, revisioned workspace persistence, redirect handling, CORS origin restrictions and rejection of unauthenticated writes.
- `wrangler.jsonc`: separate `executive-visuals-d1-staging` Worker configuration, bound only to the existing `executive-visuals-staging` D1 database and restricted to the exact Executive Visuals app origin for browser API calls.
- `docs/D1-STAGING-FOUNDATION.md`: this integration boundary and rollout plan.

## Staging endpoints

- Worker health: `GET https://executive-visuals-d1-staging.chrishem.workers.dev/edge-health` — live check returned HTTP 200 with `d1Bound=true`, `apiProxyConfigured=true`, and `stagingOnly=true`.
- D1 schema health: `GET https://executive-visuals-d1-staging.chrishem.workers.dev/api/d1/health` — live check returned HTTP 200 with `metadataOnly=true` and `r2Enabled=false`.
- Anonymous project access: `GET https://executive-visuals-d1-staging.chrishem.workers.dev/api/d1/projects` — live check returned HTTP 401 `AUTH_REQUIRED`.
- Read-only D1 audit confirmed migration `0001_initial.sql`, all seven `ev_*` tables, and zero rows in user, project, membership, workspace-document, asset, job and audit tables.
- Sign in: `POST /api/auth/login` (proxied only to the existing Render auth endpoint)
- Create/list staging projects: `POST/GET /api/d1/projects`
- Read/update staging project: `GET/PATCH /api/d1/projects/:id`
- Read/update persisted workspace documents: `GET/PUT /api/d1/projects/:id/workspace` (revision checked; maximum document size 256 KB)

The staging Worker blocks production business routes such as `/api/projects` and `/api/assets`. The supported browser path is the same-origin Render `/api/d1/*` proxy, which forwards the existing HttpOnly session cookie server-to-server. The Worker also has a strict origin allow-list for direct Bearer-token calls, but browser cookies are not shared across the Render and workers.dev domains.

## Local verification

```bash
npm run verify:d1
```

The test suite applies the migration to local in-memory SQLite databases. It verifies schema creation, external-principal mapping, project access roles, revision conflicts, asset checksum/storage-key validation, Worker identity verification through the existing `/api/me` endpoint, revisioned workspace persistence, CORS allow-list enforcement, and rejection of production business API routes. The Worker does not trust browser-supplied owner IDs; it derives identity from the existing API's authenticated session. It cannot proxy production project, asset, job, or other business APIs.

For Cloudflare local development, configure a D1 binding with `remote = false` (the default) and use Wrangler local migrations. Never use `--remote` during ordinary tests. Cloudflare documents that local D1 state is separate from remote state; remote writes are irreversible through local development.

## Staged rollout

1. Review and merge this code only after CI passes.
2. Add the D1 binding to a separately reviewed Worker configuration, targeting only database `executive-visuals-staging`.
3. Run `wrangler d1 migrations apply executive-visuals-staging --local` against a local simulator and verify the migration ledger.
4. **Completed:** apply `0001_initial.sql` to the isolated remote `executive-visuals-staging` database and record it in `d1_migrations`. Verified seven `ev_*` tables and zero user/project/asset/job rows.
5. **Completed:** deploy `executive-visuals-d1-staging` as a separate Worker on its workers.dev subdomain, with no custom domain or production route. It permits only login/logout, `/api/me`, and `/api/d1/*`; all other application/business routes return 404. The Render API is contacted only for authentication and identity verification.
6. **Completed:** add revisioned D1 workspace-document GET/PUT endpoints, strict body bounds, and owner/editor write authorization; viewers/reviewers remain read-only.
7. **Completed:** restrict browser CORS to the exact Executive Visuals app origin and Bearer authorization; cross-origin cookies are disabled. The deployed Worker reports the exact staging-only and D1-bound health flags.
8. Configure `D1_STAGING_WORKER_URL` only on a separately approved isolated Executive Visuals staging service; do not set it on production. The variable is not configured on the live production service.
9. Run a live authenticated smoke test and workspace round-trip through the same-origin proxy; confirm unauthenticated requests cannot create D1 principals or projects.
10. Keep Render SQLite as the current application source of truth until API compatibility, consistency, recovery, export/restore and tenant-isolation acceptance pass. Do not redirect the existing `/api/projects` route until all project-dependent endpoints have been migrated together.

## Deliberately not done

- No production Worker binding, deployed Worker code, route, or environment variable was changed.
- No production route, main application API, or Render service has been switched to D1. The new same-origin proxy is inert until its staging-only environment variable is set.
- No Render deployment or production service was changed.
- No Supabase project, key, or auth configuration was changed.
- No R2 bucket was activated or created.
- No paid service was enabled.


## Free-plan guardrails and live staging baseline

The staging design must remain within the account's existing free allowances. As documented by Cloudflare (reviewed 9 November 2026):

- Workers Free: 100,000 requests per day, 10 ms CPU time per HTTP request, and 50 subrequests per invocation. A Worker that exceeds the daily request allowance returns error 1027; do not assume unlimited availability.
- D1 Free: up to 10 databases per account, 500 MB per database, 5 GB total D1 storage, 5 million rows read per day, 100,000 rows written per day, and 7 days of Time Travel history.
- Keep metadata only in D1. Media bytes, large binary payloads, render outputs and proxies must not be stored in SQL rows. R2 remains disabled until separately approved; no paid-plan upgrade is permitted by this plan.

References: [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/) · [Workers pricing and included usage](https://developers.cloudflare.com/workers/platform/pricing/).

Read-only account audit on 9 November 2026 observed the existing `executive-visuals-staging` database at 126,976 bytes. The migration ledger contains exactly `0001_initial.sql`; all seven application tables (`ev_users`, `ev_projects`, `ev_project_members`, `ev_project_workspace_documents`, `ev_assets`, `ev_jobs`, `ev_audit_events`) exist and each currently contains zero rows. The only write observed was none: the audit used SELECT statements only. No user or project data was seeded. The direct endpoint checks were also read-only; the unauthenticated project request was rejected before any principal or project could be created.

**Metadata caveat:** the Cloudflare database-list response reported `num_tables: 0` during this audit, while a direct read-only query against `sqlite_master` confirmed the seven application tables, migration ledger and indexes. Use the direct schema/migration query as the acceptance evidence; do not treat the list-response `num_tables` field as authoritative until its discrepancy is explained.

Free-plan quotas are ceilings, not a capacity guarantee. Add application-level request/body bounds, bounded pagination, index-backed queries and a visible quota/error state before inviting external testers. Avoid automatic retries that can multiply reads or writes after quota errors.


### Quota exhaustion and bounded-query behavior (reviewed 9 November 2026)

Cloudflare's current Free-plan documentation makes the daily D1 row quotas enforced limits, not advisory targets. Since 1 September 2026, queries fail when the account exceeds its daily row-read or row-write allowance; the stored data is not deleted, and query access resumes after the UTC-midnight reset. The application must not silently upgrade, enqueue unbounded retries, or interpret quota errors as empty result sets.

- Workers Free daily request exhaustion returns Cloudflare error 1027. For this isolated staging Worker, surface a clear unavailable/limit response and retain fail-closed behavior for protected API routes.
- D1 Free permits at most 50 D1 query subrequests per Worker invocation; use a much smaller application budget, bounded page sizes, indexed tenant filters and explicit query-count tests.
- Keep row reads/writes visible in operational checks using D1 query metadata/analytics. A filtered query over an unindexed tenant or timestamp column can consume the read quota through a table scan.
- Maximum D1 row/string/BLOB size is 2,000,000 bytes; the workspace-document API's 256 KB limit remains intentionally lower. Never put media payloads in D1.
- D1 query results are limited to 50 MB (effective 4 November 2026). Keep API responses far below this ceiling with bounded pagination and narrow projections; workspace documents remain capped at 256 KB.
- A Worker can open at most six simultaneous D1 connections per invocation. A D1 `batch()` counts as one query against the per-invocation query-call limit, while each statement still has its own SQL/result limits; prefer bounded batches over parallel unbounded queries.
- On a quota-limit error, return a distinct retry-after-reset/unavailable signal; do not automatically retry in a tight loop. A retry after UTC midnight must be initiated by a bounded client/operator action.

Authoritative references (reviewed 9 November 2026): [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing and free allowances](https://developers.cloudflare.com/d1/platform/pricing/), and [D1 free-tier daily limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).
