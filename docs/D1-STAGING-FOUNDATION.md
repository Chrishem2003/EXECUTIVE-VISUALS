# Cloudflare D1 staging foundation

**Status (13 November 2026):** isolated D1 schema and Worker are deployed. The staging same-origin bridge is enabled only on the dedicated Render staging service. Live authenticated registration/login, project create/list, revisioned workspace save/reload, anonymous-access rejection, and two-account owner-isolation checks have passed. Local Worker/repository tests cover viewer/reviewer read-only behavior, editor writes, owner-only membership administration and revocation. A fresh read-only aggregate audit on 13 November found 5 users, 5 projects and 5 workspace documents; memberships, assets, jobs and audit events were zero. These totals are not attributed to a particular smoke run. The live acceptance script exercises the full member-role matrix and has an explicitly confirmed, manual-only GitHub Actions workflow; its expanded live run remains pending. Production health confirms Supabase auth remains active and the D1 staging bridge remains disabled.

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
- Live D1 audit confirmed migration `0001_initial.sql` and all seven `ev_*` tables. The accepted smoke workflow created three staging smoke identities, three projects and three workspace documents; memberships, assets, jobs and audit events remain zero. This is test data in the isolated staging database.
- Sign in: `POST /api/auth/login` (proxied only to the existing Render auth endpoint)
- Create/list staging projects: `POST/GET /api/d1/projects`
- Read/update staging project: `GET/PATCH /api/d1/projects/:id`
- Read/update persisted workspace documents: `GET/PUT /api/d1/projects/:id/workspace` (revision checked; maximum document size 256 KB)
- Read private asset metadata: `GET /api/d1/assets?projectId=:id&limit=50&offset=0` (authenticated and owner/member scoped; returns checksums and descriptive metadata but never storage keys or media bytes)
- The Cloud Projects workspace includes an opt-in D1 staging panel. It checks the public `/api/health` staging capability flag before rendering; the panel is hidden entirely unless `D1_STAGING_WORKER_URL` is configured on that application environment. Once visible, it checks the authenticated same-origin `/api/d1/health` bridge, lists/creates staging projects, reads/writes revision-checked workspace JSON, and displays metadata-only asset records. Production remains hidden and disabled when the variable is absent.

The staging Worker blocks production business routes such as `/api/projects` and `/api/assets`. The supported browser path is the same-origin Render `/api/d1/*` proxy, which forwards the existing HttpOnly session cookie server-to-server. The Worker also has a strict origin allow-list for direct Bearer-token calls, but browser cookies are not shared across the Render and workers.dev domains.

## Local and live verification

```bash
npm run verify:d1
```

The local command syntax-checks the live acceptance script and exercises repository/Worker authorization using in-memory SQLite. For live acceptance, manually run GitHub Actions → **D1 staging live acceptance**, explicitly confirm that disposable users/projects/memberships may be written to the isolated staging database, and inspect the resulting logs. The workflow is manual-only, requires no production secrets, does not run on pull requests or a schedule, and must not be pointed at production. It creates staging smoke identities and project records; it is not a cleanup or production migration workflow.

The test suite applies the migration to local in-memory SQLite databases. It verifies schema creation, external-principal mapping, project access roles, revision conflicts, asset checksum/storage-key validation, Worker identity verification through the existing `/api/me` endpoint, revisioned workspace persistence, CORS allow-list enforcement, and rejection of production business API routes. The Worker does not trust browser-supplied owner IDs; it derives identity from the existing API's authenticated session. It cannot proxy production project, asset, job, or other business APIs.

For Cloudflare local development, configure a D1 binding with `remote = false` (the default) and use Wrangler local migrations. Never use `--remote` during ordinary tests. Cloudflare documents that local D1 state is separate from remote state; remote writes are irreversible through local development.

## Staged rollout

1. **Completed:** review and merge the staging implementation after exact-head CI passed.
2. **Completed:** configure the D1 binding on the separately deployed Worker, targeting only database `executive-visuals-staging`.
3. **Completed:** run the SQLite-compatible migration locally and verify the migration ledger.
4. **Completed:** apply `0001_initial.sql` to the isolated remote staging database. All seven `ev_*` tables and the migration ledger are present.
5. **Completed:** deploy `executive-visuals-d1-staging` on its workers.dev subdomain with no custom domain or production route. It permits only login/logout, `/api/me`, and `/api/d1/*`; all other application/business routes return 404.
6. **Completed:** add revisioned D1 workspace-document GET/PUT endpoints, strict body bounds, and owner/editor write authorization; viewers/reviewers remain read-only.
7. **Completed:** restrict browser CORS to the exact staging app origin and Bearer authorization; cross-origin cookies are disabled.
8. **Completed:** configure `D1_STAGING_WORKER_URL` only on the dedicated Render staging service. It remains absent from production.
9. **Completed (13 November):** live allowlisted registration/login, `/api/me` identity verification, authenticated D1 project create/list, revision 1 → 2 workspace save/reload, exact document comparison, and anonymous project rejection through the same-origin staging proxy. Read-only D1 audit confirms three staging smoke identities, three projects and three workspace documents; memberships, assets, jobs and audit events remain zero.
10. **Completed (13 November):** two independently authenticated staging identities cannot list, read, or write each other's projects/workspace documents; each can access its own project.
11. **Implemented; live run pending:** `scripts/verify-d1-staging-live.mjs` exercises Owner, Editor, Reviewer and Viewer permissions, read-only enforcement for Viewer/Reviewer, Editor workspace writes, owner-only member administration, rejected owner self-removal and immediate access revocation. `.github/workflows/d1-staging-live-acceptance.yml` exposes this as a manual-only workflow with an explicit staging-write confirmation; it is intentionally not scheduled and does not run on pull requests. The full live matrix must pass before the shared-member role acceptance checkbox is closed.
11. Keep Render SQLite as the current application source of truth until API compatibility, consistency, recovery, export/restore and media-storage acceptance pass. Do not redirect the existing `/api/projects` route until all project-dependent endpoints have been migrated together.

## Deliberately not done

- No production Worker binding, deployed Worker code, route, or environment variable was changed.
- No production route or main application API has been switched to D1. The D1 bridge is enabled only on the isolated staging service.
- The main-branch merge triggered the existing Render production auto-deploy; production health still reports Supabase authentication and the D1 staging bridge disabled. No production environment configuration or database was changed.
- No Supabase project, key, or auth configuration was changed.
- No R2 bucket was activated or created.
- No paid service was enabled.

## Free-plan guardrails and live staging baseline

The staging design must remain within the account's existing free allowances. As documented by Cloudflare (reviewed 9 November 2026):

- Workers Free: 100,000 requests per day, 10 ms CPU time per HTTP request, and 50 subrequests per invocation. A Worker that exceeds the daily request allowance returns error 1027; do not assume unlimited availability.
- D1 Free: up to 10 databases per account, 500 MB per database, 5 GB total D1 storage, 5 million rows read per day, 100,000 rows written per day, and 7 days of Time Travel history.
- Keep metadata only in D1. Media bytes, large binary payloads, render outputs and proxies must not be stored in SQL rows. R2 remains disabled until separately approved; no paid-plan upgrade is permitted by this plan.

References: [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/) · [Workers pricing and included usage](https://developers.cloudflare.com/workers/platform/pricing/).

Historical read-only account audit on 9 November 2026 observed the `executive-visuals-staging` database at 126,976 bytes, with all seven application tables present and zero application rows at that time. A later read-only audit on 13 November queried `sqlite_master` and aggregate counts directly against the same database: the seven `ev_*` tables and migration ledger are present; `ev_users` contains 5 rows, `ev_projects` 5, `ev_project_workspace_documents` 5, and `ev_project_members`, `ev_assets`, `ev_jobs` and `ev_audit_events` each contain zero rows. The database-list response's `num_tables` field was not treated as authoritative. This later audit used SELECT statements only and made no writes; aggregate counts do not identify which run created each record. The direct endpoint checks were also read-only; the unauthenticated project request was rejected.

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
