# Neon staging integration — guarded bootstrap

**Status:** repository-side preparation only. No Neon project, branch, database, Data API, bucket, credential, or Render setting is created or changed by adding this document or workflow.

## Why this is manual-only

The Neon GitHub integration normally makes these repository values available:

- Repository variable: `NEON_PROJECT_ID`
- Repository secret: `NEON_API_KEY`

The integration does not by itself configure the Render application, apply this repository's SQL migrations, enable the Neon Data API, create a private object-storage bucket, or make the current Supabase-backed worker compatible with Neon.

Official references:

- [Neon GitHub branching workflow](https://neon.com/docs/get-started/workflow-primer)
- [Neon create-branch GitHub Action](https://github.com/neondatabase/create-branch-action)
- [Neon Data API security](https://neon.com/docs/data-api/get-started)
- [Neon plans and quotas](https://neon.com/docs/introduction/plans)
- [Neon Free quota FAQ](https://neon.com/docs/faqs/free-plan-limits-and-quotas)
- [Neon Object Storage](https://neon.com/docs/storage/overview)

## Free-plan capacity — conservative planning values

Neon's current public documentation is inconsistent on the PostgreSQL storage allowance: the Free-plan FAQ says **1 GB per project**, while the plans page still contains a **0.5 GB per project** statement. Until the account console confirms the allowance for this project, plan against 0.5 GB and treat 1 GB as unconfirmed.

| Resource | Public Free allowance / constraint |
| --- | ---: |
| Monthly plan price | $0 |
| Projects | 100 |
| Branches | 10 per project |
| PostgreSQL storage | 1 GB/project in current FAQ; older plans page still says 0.5 GB; 20 GB account-wide |
| Compute | 100 CU-hours/project/month |
| Maximum autoscaling | 2 CU (approximately 8 GB RAM) |
| Scale-to-zero | After 5 minutes; cannot be disabled on Free |
| Public network transfer | 5 GB/project/month, shared by Postgres, Object Storage and Functions |
| Object Storage | 5 GB/project |
| Object Storage API | S3-compatible; private buckets supported |
| Object storage egress | Counts toward the shared project transfer allowance |

The Free allowance is suitable for integration testing and low-volume staging, not a media-production workload with large video files. The 5 GB object store and 5 GB shared transfer allowance are the practical bottlenecks.

## Workflow safety contract

`.github/workflows/neon-staging-bootstrap.yml` is deliberately `workflow_dispatch` only. It:

1. Requires an explicit boolean confirmation.
2. Requires the GitHub integration's `NEON_PROJECT_ID` variable and `NEON_API_KEY` secret to exist.
3. Creates only the branch `executive-visuals-staging` from a parent named `staging-base`.
4. Does not fall back to the Neon default branch.
5. Fails if the target branch already exists rather than silently reusing it.
6. Never prints, uploads, or stores the database connection URI.
7. Does not apply migrations, enable Data API, create buckets, or modify Render settings.

**Before running it:** verify in the Neon Console that the connected Neon project is dedicated to Executive Visuals staging, and that `staging-base` exists and contains no production/customer data. If that parent does not exist, stop; do not substitute `main`, `production`, or another unverified branch.

The workflow uses the Neon create-branch Action pinned to commit `fb620d43d4c565abaf088b848a4e28e5c4ea4d9c` (v6).

## Compatibility gap that must be resolved before application connection

The current cloud worker uses Supabase-specific REST conventions:

- `apikey` and `Authorization: Bearer <service-role-key>`
- PostgREST `/rest/v1` table and RPC routes
- Supabase schema profile headers
- Existing RPC names for queue leasing, submission idempotency, and customer-credit settlement

Neon's Data API is also PostgREST-compatible, but its authorization model is JWT + PostgreSQL GRANT/RLS. It is **not** a drop-in replacement for a Supabase service-role key. The Data API documentation explicitly states that the endpoint has no independent permission layer and that all access is determined by PostgreSQL grants and RLS.

The safer server-side design is to add a separate Neon/PostgreSQL adapter using a server-only pooled connection string and a least-privilege database role, then port and test the required schema/functions. Keep the existing Supabase adapter intact. Do not put a Neon API key or database URL in Vite/browser variables.

## Storage compatibility gap

The asset service now includes a dedicated `neon-object-storage.mjs` adapter and accepts `CLOUD_MEDIA_STORAGE_PROVIDER=neon`. It uses path-style S3 requests and AWS Signature Version 4, matching Neon documentation. It supports private uploads, streaming file uploads, short-lived presigned GET URLs, object deletion, readiness checks, and streamed size/content-type/SHA-256 verification.\n\nThe adapter does not create buckets or credentials. It requires a bucket to exist on the selected branch and server-only environment values: `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_REGION`, `NEON_STORAGE_ACCESS_KEY_ID` (Neon `token_id`), `NEON_STORAGE_SECRET_ACCESS_KEY` (Neon `s3_secret_access_key`), and `NEON_STORAGE_BUCKET`. It also accepts Neon standard `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` names. Issue a credential with both `storage:read` and `storage:write` scopes for server-side upload, download signing and deletion. Never expose these values to the browser.\n\nCurrent adapter upload size defaults to 250 MiB, intentionally below the Neon single-PUT maximum and the application's existing media upload policy. Neon supports S3 path-style addressing only; the adapter uses the branch endpoint exactly as returned by Neon. The existing canonical bucket contract remains `executive-visuals-media`; the adapter refuses a custom bucket until metadata and cleanup contracts support configurable bucket identifiers.\n\nThis is a storage-provider integration only: cloud asset metadata, authorization and publication RPCs still use the existing Supabase repository boundary. It does not make the video worker or database layer Neon-compatible, and it does not enable Neon in any deployed environment.

The existing canonical bucket contract also expects `executive-visuals-media`. Any Neon bucket adapter must preserve that logical bucket contract or introduce a reviewed migration for configurable bucket identifiers. No existing storage provider should be switched automatically.

## Current repository implementation\n\n- `server/neon-object-storage.mjs` — server-side Neon S3-compatible adapter.\n- `server/cloud-asset-service.mjs` — explicit `neon` provider selection; existing Supabase/R2/B2 providers remain available.\n- `server/tests/neon-object-storage.test.mjs` — request signing, path-style addressing, signed downloads, streamed upload, integrity verification, deletion and path validation tests.\n- `npm run verify:neon-storage` — focused adapter and composition test command.\n\nThese tests use mocked S3 responses. They prove the local adapter contract, not live Neon credentials, bucket provisioning, or deployed connectivity.\n\n## Required acceptance before connecting Render staging

- [ ] Confirm the Neon project is dedicated to staging and its region/Free entitlement.
- [ ] Confirm the `staging-base` branch is empty or contains only synthetic test fixtures.
- [ ] Create the isolated child branch through the manual workflow after separate operator confirmation.
- [ ] Establish a migration baseline for the Executive Visuals schema; do not replay Supabase migration history blindly.
- [ ] Port and test queue claim/renew/recover/finish functions and submission/budget/settlement functions.
- [ ] Verify transactionality, idempotency, row locking, lease fencing, RLS and tenant isolation against real Neon PostgreSQL.
- [x] Implement and unit-test a dedicated private Neon Object Storage adapter, signed downloads, streamed uploads, deletion and object integrity verification.\n- [ ] Provision the private bucket and issue branch-scoped storage credentials after separate approval.\n- [ ] Run an authenticated integration test against the actual Neon staging branch.\n- [ ] Add multipart/resumable upload orchestration for media exceeding the current 250 MiB application limit.
- [ ] Verify backup/restore and object cleanup/reconciliation.
- [ ] Only then prepare a separate Render staging environment-variable change for review and approval.

No production database, shared Supabase project, production Render service, customer data, or paid provider configuration is part of this plan.
