# Batch 148 — Staging readiness must fail closed

## Finding

The staging environment preflight correctly returned `state: "BLOCKED"` when required GitHub Actions environment secrets and variables were absent, but the command exited with status 0. This allowed GitHub Actions to display a successful `staging-preflight` check even though staging acceptance could not run.

A captured run on 28 November 2026 confirmed the false-green state: the report listed 16 missing configuration names and no invalid values, while the job was marked successful. No secret values were printed.

## Change

The readiness script now exposes `stagingReadinessExitCode(report, { requireReady })`.

- Report-only mode keeps its prior behavior for setup and diagnostics: `BLOCKED` is a valid report result, while `INVALID` exits non-zero.
- Strict mode (`--require-ready`) exits non-zero unless the state is exactly `READY`.
- The staging preflight GitHub Actions job now runs strict mode, so a missing or malformed staging configuration is visible as a failed readiness gate instead of a false success.
- Unit tests cover report-only behavior, strict BLOCKED failure, READY success, and INVALID failure.

## Required staging configuration

Configure these names in the GitHub Actions `staging` environment. Values must be added directly in GitHub settings; never commit them or paste secret values into issues or chat.

Secrets:
- `SUPABASE_STAGING_URL`
- `SUPABASE_STAGING_ANON_KEY`
- `SUPABASE_STAGING_SECRET_KEY`
- `SUPABASE_STAGING_DB_URL`
- `STORAGE_TEST_OWNER_JWT`
- `STORAGE_TEST_OTHER_JWT`
- `STAGING_BACKUP_ENCRYPTION_PASSPHRASE`
- `PADDLE_SANDBOX_API_KEY`
- `PADDLE_WEBHOOK_SECRET`
- `PESAPAL_SANDBOX_CONSUMER_KEY`
- `PESAPAL_SANDBOX_CONSUMER_SECRET`
- `OPS_ALERT_WEBHOOK_URL`

Variables:
- `STORAGE_TEST_OWNER_ID`
- `EXECUTIVE_VISUALS_HEALTH_URL`
- `PESAPAL_IPN_ID`
- `PESAPAL_CALLBACK_URL`

The script validates that the Supabase URL and database URL point to the approved staging project, Paddle uses a sandbox key, the Pesapal callback targets the staging Render route, and all operational URLs use HTTPS. It reports names and states only, never values.

## Safety

This batch does not add or modify any GitHub secret, provider credential, Supabase setting, database, Render service, or production deployment. It makes the readiness check honest and fail-closed. Actual private-storage, worker restart, encrypted backup, monitoring alert and payment sandbox acceptance remain separately gated staging operations.
