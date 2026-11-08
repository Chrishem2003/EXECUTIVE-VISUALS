# Cloudflare D1 staging foundation

**Status:** isolated schema and repository adapter proposed for review. Not connected to the deployed Worker and not applied to any remote database.

## Boundary and identity

The D1 database is only for Executive Visuals staging. The adapter expects an identity that has already been authenticated by the existing API/identity provider. It maps the verified provider subject to an internal D1 principal; it does not validate JWTs, store passwords, or accept a browser-supplied owner ID as proof of identity.

The schema stores metadata only. It does not store media bytes, provider secrets, access/refresh tokens, password hashes, or public media URLs. Asset rows contain private storage keys and checksums. R2 remains disabled until the user explicitly approves its dashboard activation and any overage billing risk.

## Files

- `migrations/d1/0001_initial.sql`: SQLite-compatible D1 schema for principal mapping, projects, memberships, workspace documents, asset metadata/provenance, job metadata and audit events.
- `server/d1-repository.mjs`: parameterized D1 repository. Project reads are scoped to owner/member; writes enforce owner/editor roles and optimistic revisions.
- `server/tests/d1-repository.test.mjs`: local in-memory SQLite tests using the same SQL migration. No remote D1 binding is used.
- `cloudflare/worker.mjs`: separate staging Worker that exposes isolated `/api/d1/*` endpoints and proxies only login/logout plus the authenticated `/api/me` identity check. All other production business API routes are blocked.
- `cloudflare/worker.test.mjs`: Worker tests for schema readiness, upstream authentication, project creation/listing and rejection of unauthenticated writes.
- `wrangler.jsonc`: separate `executive-visuals-d1-staging` Worker configuration, bound only to the existing `executive-visuals-staging` D1 database.
- `docs/D1-STAGING-FOUNDATION.md`: this integration boundary and rollout plan.

## Staging endpoints

- Worker health: `GET https://executive-visuals-d1-staging.chrishem242.workers.dev/edge-health`
- D1 schema health: `GET https://executive-visuals-d1-staging.chrishem242.workers.dev/api/d1/health`
- Sign in: `POST /api/auth/login` (proxied only to the existing Render auth endpoint)
- Create/list staging projects: `POST/GET /api/d1/projects`
- Read/update staging project: `GET/PATCH /api/d1/projects/:id`

The staging Worker blocks production business routes such as `/api/projects` and `/api/assets`.

## Local verification

```bash
npm run verify:d1
```

The test suite applies the migration to local in-memory SQLite databases. It verifies schema creation, external-principal mapping, project access roles, revision conflicts, asset checksum/storage-key validation, Worker identity verification through the existing `/api/me` endpoint, and the D1 project API. The Worker does not trust browser-supplied owner IDs; it derives identity from the existing API's authenticated session. It cannot proxy production project, asset, job, or other business APIs.

For Cloudflare local development, configure a D1 binding with `remote = false` (the default) and use Wrangler local migrations. Never use `--remote` during ordinary tests. Cloudflare documents that local D1 state is separate from remote state; remote writes are irreversible through local development.

## Staged rollout

1. Review and merge this code only after CI passes.
2. Add the D1 binding to a separately reviewed Worker configuration, targeting only database `executive-visuals-staging`.
3. Run `wrangler d1 migrations apply executive-visuals-staging --local` against a local simulator and verify the migration ledger.
4. **Completed:** apply `0001_initial.sql` to the isolated remote `executive-visuals-staging` database and record it in `d1_migrations`. Verified seven `ev_*` tables and zero user/project/asset/job rows.
5. **Completed:** deploy `executive-visuals-d1-staging` as a separate Worker on its workers.dev subdomain, with no custom domain or production route. It permits only login/logout, `/api/me`, and `/api/d1/*`; all other application/business routes return 404. The Render API is contacted only for authentication and identity verification.
6. Run a live authenticated smoke test; confirm unauthenticated requests cannot create D1 principals or projects.
7. Keep Render SQLite as the current application source of truth until API compatibility, consistency, recovery, export/restore and tenant-isolation acceptance pass. Do not redirect the existing `/api/projects` route until all project-dependent endpoints have been migrated together.

## Deliberately not done

- No production Worker binding, deployed Worker code, route, or environment variable was changed.
- No staging Worker has been deployed yet.
- No Render deployment or production service was changed.
- No Supabase project, key, or auth configuration was changed.
- No R2 bucket was activated or created.
- No paid service was enabled.
