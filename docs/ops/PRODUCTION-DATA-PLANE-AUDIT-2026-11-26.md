# Production data-plane and launch-readiness audit — 26 November 2026

## Executive summary

The production Render service is reachable, but its HTTP health response is a liveness signal, not evidence that the application is ready to accept paid customer work. The live endpoint returned HTTP 200 and `status=ok`, while reporting SQLite/local-disk persistence, disabled local uploads, disabled cloud media, disabled billing and a disabled cloud video worker.

## Verified infrastructure inventory

### Render production

- Service: `EXECUTIVE-VISUALS`
- URL: `https://executive-visuals.onrender.com`
- Branch: `main`
- Auto-deploy: enabled on commits
- Plan: Free; one instance; Frankfurt
- No dedicated Executive Visuals background worker exists in the inspected workspace.
- The live health response reports `database=sqlite`, `storage=local-disk`, `persistence.durableAcrossDeploys=false`, local uploads disabled, `cloudMedia.enabled=false`, `billing.enabled=false`, and `cloudVideoWorker.enabled=false`.

The Render Free filesystem is ephemeral. Do not treat this service as a durable paid-customer runtime.

### Supabase projects

- `Chrishem Project` is the existing shared NEMA/platform project. It contains public NEMA and platform-job tables, seven recorded migrations, no `executive_visuals` schema tables and no Storage buckets. It must not be repurposed for Executive Visuals.
- `Chrishem Platform Staging` contains the Executive Visuals schema and the private `executive-visuals-media` bucket. The bucket is private, has a 50 MiB object limit and four authenticated Storage RLS policies. It currently contains zero objects.
- The staging schema has 85 RLS-enabled tables without table policies, but direct SQL privilege checks found zero of those tables accessible to `anon` or `authenticated`; the `executive_visuals` schema itself has no USAGE granted to either client role. Preserve the service-role-only boundary rather than adding broad client policies to silence informational advisor findings.
- The staging project's migration history is not a clean isolated production baseline. Do not repair, reset or replay it as a shortcut.

### Existing Neon project

- Organization plan: Free.
- Existing project: `Executive-Visuals Pro` (`dawn-credit-96457353`).
- Branches observed: `production`, `staging-base`, and `executive-visuals-staging`.
- Read-only branch inspection found only an empty `public` schema on `production` and `staging-base`; the dedicated `executive-visuals-staging` branch had no compute endpoint at inspection time.
- Source-controlled Neon migrations `0001`–`0009` exist, but they are not applied to these Neon branches. Their source comments explicitly require a separately approved staging branch and migration plan.
- No Neon branch was changed and no connection string/password was retrieved.

The existing Neon project is a possible isolated PostgreSQL target, not a verified production database. The staging branch's private media bucket is a useful provisioned component, but it does not establish database readiness or tenant-isolated storage acceptance. The staging branch inherits its parent lineage and the prior integration runbook still requires a reviewed sanitization/empty-staging plan. Do not point Render at it or apply migrations until branch isolation, migration baseline, connection/pool settings, backup strategy and rollback plan have been approved and tested.

## Readiness contract

`scripts/verify-production-runtime-readiness.mjs` performs a read-only GET of the configured health endpoint. It reports runtime blockers for:
- PostgreSQL rather than SQLite
- durable storage rather than local ephemeral disk
- ready private cloud media
- configured Supabase auth session
- a separately operated worker
- explicitly configured remote provider execution
- configured payment provider credentials

It separately reports manual acceptance still required for private storage tenant isolation, worker restart/queue recovery, encrypted backup and isolated restore, real alert delivery, provider sandbox lifecycle/reconciliation, and production database cutover/rollback.

A passing runtime report is not paid-launch approval. The script exits with code 2 when runtime blockers remain; invalid HTTP/JSON exits nonzero.

## Change and cost boundary

This audit made no production or shared Supabase changes, no Neon migrations, no Render configuration changes, no deployments, no new services, no paid plan upgrades and no provider calls. It did not retrieve or expose connection strings, passwords, JWTs or API keys.

The production Render service auto-deploys `main`. Keep all PRs review-only until the complete staging and release sequence is accepted; do not merge a workflow-only PR to `main` just to unlock GitHub manual dispatch.


## Neon inspection note
Read-only schema inspection caused the existing Neon `production` and `staging-base` compute endpoints to wake at their configured 0.25–2 CU limits. No new endpoint, branch, database, role or schema was created; no SQL migration was applied. Because the organization is on the Free plan, this used existing included compute allowance rather than upgrading or provisioning paid infrastructure. Allow the endpoints to autosuspend after inactivity.
