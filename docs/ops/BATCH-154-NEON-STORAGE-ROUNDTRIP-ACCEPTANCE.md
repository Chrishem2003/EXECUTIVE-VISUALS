# Neon private object-storage round-trip acceptance — Batch 154

**Scope:** isolated staging only. This check verifies the existing private Neon Object Storage bucket without provisioning resources, changing database schemas, or touching Render/production.

## What this acceptance proves

The command performs one small synthetic object lifecycle against the configured Neon branch:

1. Confirms the bucket responds as private.
2. Uploads a generated, non-customer fixture under a random UUID namespace.
3. Reads the object back through the authenticated S3 API and checks byte count and SHA-256.
4. Creates a 120-second presigned GET URL and downloads the object without credentials in the URL host.
5. Verifies downloaded bytes and SHA-256.
6. Deletes the temporary object and fails if cleanup cannot be confirmed.

It prints only a non-sensitive acceptance receipt. It never prints credentials, endpoint authorization headers, or signed URLs.

## Required server-only environment

- `NEON_STORAGE_ENDPOINT`
- `NEON_STORAGE_REGION`
- `NEON_STORAGE_ACCESS_KEY_ID` — Neon credential `token_id`
- `NEON_STORAGE_SECRET_ACCESS_KEY` — Neon credential `s3_secret_access_key`
- `NEON_STORAGE_BUCKET` — defaults to `executive-visuals-media`

Use the credential scoped to the approved isolated staging branch. Keep it in protected GitHub environment secrets or the staging service's secret manager. Do not put it in Vite variables, browser bundles, commits, logs or chat.

## Run

```sh
node scripts/verify-neon-storage-roundtrip.mjs
node --test server/tests/neon-storage-roundtrip-acceptance.test.mjs
```

## What this does not prove

This is a storage data-plane round trip, not a complete customer asset authorization test. It does not prove application-level tenant isolation, upload ownership enforcement, retention/deletion policy, media delivery through the app, or production readiness. Those require authenticated API tests with two disposable staging users and the app's real asset service.

## Safety

- No bucket creation, credential creation/rotation, SQL migration, database write, provider generation, payment, Render change or production deployment.
- Only a randomly named temporary object is written and deleted.
- If cleanup fails, the command fails and reports that manual cleanup is required.
- Keep runtime dispatch, worker and billing flags disabled until the separate staging acceptance matrix passes.

## Evidence source

The adapter under test is the existing `server/neon-object-storage.mjs`; its unit suite remains `server/tests/neon-object-storage.test.mjs`. This acceptance is deliberately additive and does not replace the existing provider abstraction.
