# Executive Visuals staging environment setup

This guide configures GitHub Actions only. It does not change Render, Supabase, Neon, production, payment live mode or customer data.

## Where to configure

In GitHub, open the repository Settings → Environments → `staging`. Add the listed values as environment secrets or variables. Keep the environment restricted to the repository owner/reviewers. Do not paste secrets into PR comments, source code or ChatGPT.

The current approved test target is the Supabase project ref `bokxljngydmqrmktofwm` (URL: `https://bokxljngydmqrmktofwm.supabase.co`). The storage, worker and backup scripts hard-reject any other Supabase project ref. This is the shared `Chrishem Platform Staging` project, not a dedicated isolated production database; acceptance remains staging-only and must not be described as production isolation.

## Required secrets

| GitHub secret | Used by | Source / requirement |
|---|---|---|
| `SUPABASE_STAGING_URL` | Storage, worker, backup | Exact URL above |
| `SUPABASE_STAGING_ANON_KEY` | Private storage test | Supabase publishable/anon key |
| `SUPABASE_STAGING_SECRET_KEY` | Worker, backup | Server-only staging secret key; never browser-exposed |
| `SUPABASE_STAGING_DB_URL` | SQL acceptance, backup | Staging Postgres connection string; direct host or pooler username must identify the approved project ref |
| `STORAGE_TEST_OWNER_JWT` | Private storage test | Short-lived JWT for disposable staging owner |
| `STORAGE_TEST_OTHER_JWT` | Private storage test | Short-lived JWT for a different disposable tenant |
| `STAGING_BACKUP_ENCRYPTION_PASSPHRASE` | Backup | At least 24 characters; store separately from encrypted artifacts |
| `PADDLE_SANDBOX_API_KEY` | Payment smoke test | Sandbox-only Paddle key containing `_sdbx_`; never a live key |
| `PESAPAL_SANDBOX_CONSUMER_KEY` | Payment smoke test | Pesapal QA/sandbox merchant key |
| `PESAPAL_SANDBOX_CONSUMER_SECRET` | Payment smoke test | Pesapal QA/sandbox merchant secret |
| `OPS_ALERT_WEBHOOK_URL` | Monitoring | HTTPS incoming webhook compatible with a JSON `text` field |

## Required environment variables

| GitHub variable | Used by | Value |
|---|---|---|
| `STORAGE_TEST_OWNER_ID` | Private storage test | UUID matching the owner JWT subject |
| `EXECUTIVE_VISUALS_HEALTH_URL` | Monitoring | Staging health endpoint, not production |
| `EXECUTIVE_VISUALS_REQUIRE_POSTGRES` | Monitoring | `true` when staging is expected to use PostgreSQL |
| `EXECUTIVE_VISUALS_REQUIRE_CLOUD_MEDIA` | Monitoring | `true` when private cloud media is expected to be ready |

## Test execution and safety

- Storage, worker, backup and payment acceptance jobs run automatically on same-repository PRs authored by `Chrishem2003`. Fork PRs cannot access the staging environment secrets.
- Manual `workflow_dispatch` and scheduled monitoring still require the workflow file on the default branch. Do not merge a workflow-only PR to `main` just to unlock these triggers: Render auto-deploys `main`.
- The storage test writes one random small object and deletes it in a `finally` block.
- The worker test writes synthetic heartbeat rows in `executive_visuals` and exercises a child process restart; it does not provision a Render worker or submit provider work.
- The backup job exports only the `executive_visuals` schema and the `executive-visuals-media` bucket. It excludes shared NEMA/public schemas and `auth.users`; the restore target must provide compatible Auth infrastructure and a reviewed identity reconciliation plan.
- The payment credential test makes only a Paddle sandbox GET and Pesapal sandbox token request. It does not create checkout or charges.
- No live payment, paid AI generation, production migration or deployment is enabled by configuring these staging secrets.
- Never use production JWTs, production service keys, production database URLs, or customer media for these tests.

## Current blockers from the latest PR runs

The owner-PR workflows now execute, but runtime acceptance stops before external requests because the GitHub `staging` environment does not currently supply the required secrets. The latest logs show empty `SUPABASE_STAGING_URL`, `SUPABASE_STAGING_DB_URL`, Paddle and Pesapal sandbox secrets. Static checks passed; these runtime checks are correctly not counted as accepted.
