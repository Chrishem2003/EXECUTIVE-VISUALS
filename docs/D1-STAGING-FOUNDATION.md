# Cloudflare D1 staging foundation

**Status:** isolated schema and repository adapter proposed for review. Not connected to the deployed Worker and not applied to any remote database.

## Boundary and identity

The D1 database is only for Executive Visuals staging. The adapter expects an identity that has already been authenticated by the existing API/identity provider. It maps the verified provider subject to an internal D1 principal; it does not validate JWTs, store passwords, or accept a browser-supplied owner ID as proof of identity.

The schema stores metadata only. It does not store media bytes, provider secrets, access/refresh tokens, password hashes, or public media URLs. Asset rows contain private storage keys and checksums. R2 remains disabled until the user explicitly approves its dashboard activation and any overage billing risk.

## Files

- `migrations/d1/0001_initial.sql`: SQLite-compatible D1 schema for principal mapping, projects, memberships, workspace documents, asset metadata/provenance, job metadata and audit events.
- `server/d1-repository.mjs`: parameterized D1 repository. Project reads are scoped to owner/member; writes enforce owner/editor roles and optimistic revisions.
- `server/tests/d1-repository.test.mjs`: local in-memory SQLite tests using the same SQL migration. No remote D1 binding is used.
- `docs/D1-STAGING-FOUNDATION.md`: this integration boundary and rollout plan.

## Local verification

```bash
npm run verify:d1
```

The test suite applies the migration to a local in-memory SQLite database. It verifies schema creation, external-principal mapping, project access roles, revision conflicts and asset checksum/storage-key validation.

For Cloudflare local development, configure a D1 binding with `remote = false` (the default) and use Wrangler local migrations. Never use `--remote` during ordinary tests. Cloudflare documents that local D1 state is separate from remote state; remote writes are irreversible through local development.

## Staged rollout

1. Review and merge this code only after CI passes.
2. Add the D1 binding to a separately reviewed Worker configuration, targeting only database `executive-visuals-staging`.
3. Run `wrangler d1 migrations apply executive-visuals-staging --local` against a local simulator and verify the migration ledger.
4. After explicit approval, apply the reviewed migration to the isolated remote staging D1 database only.
5. Implement and test the Worker identity-verification adapter before routing any customer requests to D1.
6. Add API contract tests and compare D1 reads/writes against existing application behavior before enabling any dual-write or cutover.
7. Keep Render SQLite as the current application source of truth until consistency, recovery, export/restore and tenant-isolation acceptance pass.

## Deliberately not done

- No remote D1 migration was applied.
- No Worker binding, deployed Worker code, route, or environment variable was changed.
- No Render deployment or production service was changed.
- No Supabase project, key, or auth configuration was changed.
- No R2 bucket was activated or created.
- No paid service was enabled.
