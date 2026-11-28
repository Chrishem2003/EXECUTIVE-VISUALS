# Executive Visuals staging credential setup guide

This guide is the operator checklist for the `staging` GitHub Actions environment. It contains names, locations and safe configuration guidance only. Never commit credentials or paste them into pull requests, chat, issue comments or CI logs.

## Confirmed staging resources

- Supabase project: **Chrishem Platform Staging**
- Supabase project ref: `bokxljngydmqrmktofwm`
- Supabase project URL: `https://bokxljngydmqrmktofwm.supabase.co`
- Supabase status at inspection: `ACTIVE_HEALTHY`
- Render service: **executive-visuals-cloud-staging**
- Render service URL: `https://executive-visuals-cloud-staging.onrender.com`
- Health URL: `https://executive-visuals-cloud-staging.onrender.com/api/health`
- Paddle webhook URL: `https://executive-visuals-cloud-staging.onrender.com/api/webhooks/paddle`
- Pesapal IPN URL: `https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal`

**Important Render drift:** the existing service is currently configured to deploy branch `main`, with auto-deploy on commit, the Free plan, and no Render health-check path configured. It is named staging, but its branch is not an isolated staging branch. Do not treat the URL or a passing static preflight as proof of isolated staging. Before deploying a staging release, review and explicitly approve changing this service to the chosen staging branch, setting its health-check path to `/api/health`, and controlling automatic deployments. This guide does not change the service.

## Where to add the values

Repository is public, so use the repository's **staging** environment:

1. Open the repository Settings.
2. Open **Environments** and select or create `staging`.
3. Add sensitive values under **Environment secrets**.
4. Add non-sensitive identifiers and URLs under **Environment variables**.
5. Keep the environment restricted to the intended repository branches and reviewers where supported.

The workflow reads secrets and variables from the environment named `staging`. Repository-level secrets with the same names are not a substitute for the environment values if they are not made available to this job.

## GitHub environment secrets

| Secret name | Where to obtain it | Validation / handling |
|---|---|---|
| `SUPABASE_STAGING_ANON_KEY` | Supabase Dashboard → staging project → Settings → API Keys → publishable key (or legacy anon key) | Public-class key only; never substitute the secret/service-role key |
| `SUPABASE_STAGING_SECRET_KEY` | Same API Keys page → secret key (or legacy service_role key) | Elevated backend key; never put in browser code |
| `SUPABASE_STAGING_DB_URL` | Supabase Dashboard → Connect → PostgreSQL connection string | Must point to project ref `bokxljngydmqrmktofwm`; use a secure database password and percent-encode reserved URL characters |
| `STORAGE_TEST_OWNER_JWT` | Sign in a dedicated staging storage-owner test account through Supabase Auth | Access token, not an API key; its `sub` must equal `STORAGE_TEST_OWNER_ID` |
| `STORAGE_TEST_OTHER_JWT` | Sign in a separate staging user account | Must belong to a different Auth user; used to prove cross-tenant access is denied |
| `STAGING_BACKUP_ENCRYPTION_PASSPHRASE` | Generate with a password manager or `openssl rand -base64 32` | At least 24 characters; retain a recovery copy in a secure password manager |
| `PADDLE_SANDBOX_API_KEY` | Paddle developer dashboard, with the account in **Sandbox** mode → Developer Tools / Authentication → API keys | Use a sandbox key only; never a live key |
| `PADDLE_WEBHOOK_SECRET` | Paddle sandbox → Events → Notifications → open the destination created below; copy its endpoint secret key at creation time | Must match Paddle's `pdl_ntfset_<26-character-id>_<32-character-secret>` format. Copy it when creating the destination; if needed, Paddle also lets an authorized operator retrieve it from the destination's edit view or the Get Notification Setting API. |
| `PESAPAL_SANDBOX_CONSUMER_KEY` | Pesapal developer/merchant sandbox credentials | Sandbox credentials only |
| `PESAPAL_SANDBOX_CONSUMER_SECRET` | Pesapal developer/merchant sandbox credentials | Sandbox credentials only |
| `OPS_ALERT_WEBHOOK_URL` | Create an incoming webhook in the chosen monitoring/alert destination (for example, a dedicated private channel) | HTTPS only; do not use a public channel |
 
## GitHub environment variables

| Variable name | Value / source |
|---|---|
| `STORAGE_TEST_OWNER_ID` | UUID of the dedicated staging storage-owner Auth user; must match the `sub` in `STORAGE_TEST_OWNER_JWT` |
| `EXECUTIVE_VISUALS_HEALTH_URL` | `https://executive-visuals-cloud-staging.onrender.com/api/health` |
| `PESAPAL_IPN_ID` | The `ipn_id` returned by Pesapal's sandbox RegisterIPN API |
| `PESAPAL_CALLBACK_URL` | `https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal` |
| `PADDLE_RETURN_URL` | `https://executive-visuals-cloud-staging.onrender.com/` |

The preflight verifies that the Supabase project URL and database URL match the approved staging project, that the Supabase keys have the correct privilege class, that the two storage JWTs are unexpired and belong to different users, that the Paddle API key is sandbox-scoped, and that provider/health URLs point to the approved staging service.

JWT checks inspect token claims only; the real storage acceptance test must still let Supabase verify the signature and prove tenant isolation.

Official references: [Paddle notification destinations](https://developer.paddle.com/webhooks/about/notification-destinations/) and [Paddle signature verification](https://developer.paddle.com/webhooks/about/signature-verification/).

## Create the Paddle sandbox notification destination

In Paddle Sandbox:

1. Go to **Events → Notifications → New destination**.
2. Description:

   `Executive Visuals — staging Paddle sandbox webhook (subscriptions, transactions and adjustments)`

3. Notification type: **URL**.
4. URL:

   `https://executive-visuals-cloud-staging.onrender.com/api/webhooks/paddle`

5. API version: `1`.
6. Include sensitive fields: **off**.
7. Usage type: **all** for this sandbox destination, so both platform and simulator events can be exercised in sandbox.
8. Subscribe to exactly the event types handled by the current adapter:

   - `subscription.created`
   - `subscription.activated`
   - `subscription.updated`
   - `subscription.canceled`
   - `subscription.past_due`
   - `subscription.paused`
   - `subscription.resumed`
   - `transaction.completed`
   - `transaction.payment_failed`
   - `adjustment.created`
   - `adjustment.updated`

9. Save the destination. Copy the returned `endpoint_secret_key` into GitHub environment secret `PADDLE_WEBHOOK_SECRET`. If you miss it during creation, retrieve it from the destination's edit view or the Get Notification Setting API with appropriate permission. Do not copy it into source files or a PR.

The application verifies the `Paddle-Signature` header and only applies the supported transaction-completed and subscription lifecycle events. Adjustment events are retained for financial review; they do not automatically issue refunds or mutate entitlements.

Official reference: [Pesapal API 3.0 RegisterIPNURL](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/registeripnurl).

## Register the Pesapal sandbox IPN

The application expects a GET notification at the same staging webhook route.

1. Obtain a sandbox bearer token using the Pesapal sandbox consumer key and secret.
2. Register the endpoint with Pesapal's sandbox API:

   `POST https://cybqa.pesapal.com/pesapalv3/api/URLSetup/RegisterIPN`

   JSON body:

   ```json
   {
     "url": "https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal",
     "ipn_notification_type": "GET"
   }
   ```

3. Copy the response's `ipn_id` into GitHub environment variable `PESAPAL_IPN_ID`.
4. Set `PESAPAL_CALLBACK_URL` to the same URL above.

Do not use the live Pesapal API host or live credentials for this staging destination.

## Bootstrap the first staging platform owner

The finance APIs require an explicit row in `executive_visuals.platform_admins`. The staging project currently has no rows in this allowlist. Open Supabase Dashboard → Authentication → Users, copy the verified owner's Auth UUID, then use the safe first-owner bootstrap SQL in `docs/ops/STAGING-ENVIRONMENT-VERIFICATION-2026-11-28.md`. Do not use an email or password in SQL, source code or CI logs. This owner bootstrap is a deliberate manual authorization step and is not performed by CI.

## Create the two storage test users

Create two dedicated test accounts in the **staging** Supabase Auth project only. Do not use your personal owner account or any production customer.

- User A owns the test bucket objects and is used for the authorized upload/download round-trip.
- User B is a different authenticated user and must be denied access to User A's objects.
- Record User A's Auth UUID as `STORAGE_TEST_OWNER_ID`.
- Sign in separately as User A and User B to obtain their access tokens. Put the tokens in their matching GitHub environment secrets.
- Keep the test users' passwords in a password manager. Rotate/regenerate access tokens when expired.

## Render runtime variable mapping

GitHub preflight secrets do not automatically configure Render. After reviewing the Render staging branch and deployment plan, map only the required runtime values in the **staging web service's Environment**:

| Render runtime name | Source |
|---|---|
| `SUPABASE_URL` | `SUPABASE_STAGING_URL` |
| `SUPABASE_PUBLISHABLE_KEY` | `SUPABASE_STAGING_ANON_KEY` |
| `SUPABASE_SECRET_KEY` | `SUPABASE_STAGING_SECRET_KEY` |
| `PADDLE_API_KEY` | `PADDLE_SANDBOX_API_KEY` |
| `PADDLE_WEBHOOK_SECRET` | `PADDLE_WEBHOOK_SECRET` |
| `PADDLE_API_BASE_URL` | `https://sandbox-api.paddle.com` |
| `PADDLE_RETURN_URL` | `PADDLE_RETURN_URL` |
| `PESAPAL_CONSUMER_KEY` | `PESAPAL_SANDBOX_CONSUMER_KEY` |
| `PESAPAL_CONSUMER_SECRET` | `PESAPAL_SANDBOX_CONSUMER_SECRET` |
| `PESAPAL_API_BASE_URL` | `https://cybqa.pesapal.com/pesapalv3` |
| `PESAPAL_IPN_ID` | `PESAPAL_IPN_ID` |
| `PESAPAL_CALLBACK_URL` | `PESAPAL_CALLBACK_URL` |

Keep `PADDLE_ALLOW_LIVE=false` and `PESAPAL_ALLOW_LIVE=false`. Do not enable `PADDLE_PESAPAL_BILLING_ENABLED` until the staging credentials are present, the correct service branch is deployed, and the sandbox end-to-end acceptance tests are ready to run.

The following values are CI-only and should not be copied into the public web service: database connection string, storage test JWTs, backup encryption passphrase, and the storage test owner ID. The backup passphrase belongs only in the backup/restore job that needs it.

## Run the read-only deployed runtime probe

After the values are configured in GitHub's `staging` environment and the Render staging service is intentionally switched to the approved staging branch, open Actions → **Executive Visuals staging runtime readiness** → Run workflow. Set `confirm_staging_runtime_probe` to true. The probe is read-only and will block if the app still reports SQLite, private cloud storage is unverified, provider readiness is incomplete, or no fresh worker heartbeat exists.

## Current blockers and approval boundary

- The staging preflight currently reports missing environment configuration; it does not create credentials.
- The Render service currently tracks `main` and auto-deploys commits. Changing its branch or deployment policy is a real service configuration change and requires an explicit deployment review.
- The app health handler currently reports SQLite for its application database. The durable PostgreSQL cutover and a verified restore must happen before paid launch.
- Private storage round-trip and cross-tenant denial, worker crash/recovery, encrypted backup restore, real alert delivery, and Paddle/Pesapal sandbox webhook acceptance still require their separate acceptance runs.
- No GitHub secrets, provider destinations, Supabase settings, Render service settings, production data or deployments are changed by this guide.
