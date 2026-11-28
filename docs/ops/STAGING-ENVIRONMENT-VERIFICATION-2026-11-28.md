# Staging environment verification — 2026-11-28

This is an evidence snapshot from the connected Supabase and Render workspaces. It records actual staging state separately from CI-only disposable PostgreSQL results.

## Supabase staging

Project: `Chrishem Platform Staging` (`bokxljngydmqrmktofwm`), status `ACTIVE_HEALTHY`, PostgreSQL `17.11`.

### Migrations applied after review

The following additive migrations were dry-run together in one explicit transaction and rolled back successfully, then applied individually to the staging project:

1. `verified_credit_revenue_allocation_batch_71` — adds verified credit revenue source/allocation evidence. Existing historical wallet grants are marked unattributed; this migration does not grant credits or post revenue.
2. `subscription_financial_reconciliation_batch_146` — durable read-only subscription/payment reconciliation history and Paddle lifecycle reconciliation.
3. `owner_subscription_finance_command_centre_batch_147` — owner finance reporting and two-person manual-review approval records.

The Supabase migration history now records all three. No production project was changed.

### Post-application verification

- Batch 146 reconciliation and Batch 147 tables exist.
- Batch 146 and Batch 147 RLS are enabled.
- Anonymous and authenticated roles cannot execute the reconciliation function; `service_role` can.
- A real staging reconciliation run completed with zero findings and `mutationsApplied=false`.
- Credit units remain separate from monetary liability; `monetaryLiabilityCalculated=false`.
- No subscription remediation requests or decisions have been created.
- The credit revenue source table is empty; there are no historical grants in this staging project to backfill.
- Staging currently has zero subscription rows, payment transactions, refunds, credit ledger entries and credit reservations. The reconciliation run therefore validates schema and read-only execution, not live revenue history.
- The optional `pg_cron` schema/extension is absent. No extension was installed and no recurring schedule was created. Manual reconciliation remains available.

### Owner authorization blocker

The staging `executive_visuals.platform_admins` table currently has **zero rows**. The schema supports `owner`, `platform_admin`, `billing_admin`, and `support`; no owner or finance administrator has been assigned. The new owner finance APIs therefore remain inaccessible until the correct staging Auth user is explicitly granted the owner role.

To bootstrap the first owner, the operator must:
1. Open Supabase Dashboard → Authentication → Users in the staging project.
2. Copy the verified owner's Auth **UUID** (not the email or password).
3. Run the following SQL in the staging SQL Editor, replacing the placeholder with that UUID:

```sql
insert into executive_visuals.platform_admins(user_id, role, granted_by, reason)
select u.id, 'owner', u.id, 'Initial staging platform owner bootstrap'
from auth.users u
where u.id = '<OWNER_AUTH_USER_UUID>'::uuid
  and not exists (select 1 from executive_visuals.platform_admins)
on conflict (user_id) do nothing;
```

This is intentionally not automated. It only inserts the first owner when the allowlist is empty, does not alter an existing role, and requires a real Auth user. Verify the resulting row and keep the UUID out of source code and public CI logs.

## Supabase security advisor follow-up

After the migrations, the Supabase advisors reported:

- One warning: leaked-password protection is disabled. Supabase documents this feature as available on Pro and above. Do not upgrade the project without an explicit cost decision. If remaining on Free, keep strong password requirements, email verification, rate limits and bot protection in place, and record leaked-password screening as a residual risk.
- 98 informational `rls_enabled_no_policy` findings. These are internal `executive_visuals` tables with RLS enabled and no client policies; the intended default-deny posture is appropriate where access is restricted to server-side `service_role` functions. Do not add broad client policies merely to silence the linter.
- One duplicate-index performance warning on `ai_model_price_catalog`. It is pre-existing and was not changed; review query plans before removing either index.

References: [Supabase password security](https://supabase.com/docs/guides/auth/password-security) and [Supabase API key privilege model](https://supabase.com/docs/guides/getting-started/api-keys).

## Private storage

- Bucket `executive-visuals-media` exists.
- Bucket is private (`public=false)).
- Configured object size limit: 52,428,800 bytes (50 MiB).
- Current object count: zero.
- Storage object RLS policies exist for read, insert, update and delete, scoped to owner/project membership and editor permissions as appropriate.

The real upload/download round-trip and second-user denial test has **not** run. It requires two dedicated staging Auth users and their unexpired access tokens. A private bucket and RLS policy inspection are not substitutes for that test.

## Render staging service

Service: `executive-visuals-cloud-staging`.

- URL: `https://executive-visuals-cloud-staging.onrender.com`
- Plan: Free
- Branch: `main`
- Auto-deploy: enabled on commit
- Render health-check path: empty
- Separate Executive Visuals background worker: not present in the inspected service list
- Staging heartbeat table currently has zero worker heartbeat rows.

This service is named staging but currently follows `main`; it is not isolated to the feature/staging branch. Its branch and auto-deploy policy were not changed. Before using it for release acceptance, explicitly approve the intended staging branch and deployment policy, then configure `/api/health` as the health-check path.

The current server health implementation reports its application database as SQLite. Durable PostgreSQL application persistence is still a paid-launch blocker; applying the Supabase finance migrations does not itself replace the application's SQLite repository.

## Deployed runtime acceptance gate

A separate manual workflow, `.github/workflows/staging-runtime-readiness.yml`, now performs a read-only probe after the staging variables/secrets and Render service have been configured. It requires an explicit `confirm_staging_runtime_probe=true` input and checks:

- Render health endpoint returns valid HTTP 200 health JSON.
- Application persistence reports PostgreSQL rather than SQLite.
- Supabase authentication and encrypted server sessions are ready.
- Cloud media reports private storage ready.
- Private asset egress accounting and verified actor context are enabled.
- Paddle and Pesapal are both configured for sandbox.
- Cloud video worker is enabled as a separate process.
- At least one owner/platform-admin row exists in the finance allowlist (only a count is returned; user IDs are never logged).
- At least one healthy worker heartbeat is no older than 120 seconds.

The workflow reads the health endpoint and the staging heartbeat table only. It does not mutate customer records, create provider charges, deploy services or apply migrations. It is expected to remain blocked until the actual runtime is corrected.

## Provider and operations acceptance

The fail-closed preflight currently reports 17 missing staging environment values. No values were printed. The complete source/setup guide is `docs/ops/STAGING-CREDENTIAL-SETUP-GUIDE.md`.

Still unverified against the live staging service:
- Paddle sandbox API key and notification destination secret.
- Pesapal sandbox consumer credentials and registered IPN ID.
- Actual provider webhook delivery and transaction lifecycle acceptance.
- Encrypted staging backup export and independent restore exercise.
- Real monitoring alert delivery.
- Private storage cross-tenant round-trip.
- Dedicated worker process deployment, heartbeat and crash/restart recovery.

The existing CI workflows prove code and disposable-database acceptance where they passed. They do not prove these external staging operations occurred.

## Change boundary

- No production database, Render production service, live payment credentials, or production deployments were changed.
- No paid Render plan, worker, Supabase extension, or new infrastructure was provisioned.
- Only the three named additive migrations were applied to the approved Supabase staging project after a successful transactional dry-run.
- No customer payment, subscription, credit balance, refund or entitlement was changed by the reconciliation run.
