# Batch 144 — payment provider sandbox acceptance

The manual `Payment provider sandbox acceptance` workflow performs read-only checks against Paddle and Pesapal sandbox endpoints and the approved staging plan catalogue.

## Required GitHub staging environment configuration
Secrets:
- `SUPABASE_STAGING_URL`
- `SUPABASE_STAGING_SECRET_KEY`
- `PADDLE_SANDBOX_API_KEY` (must be a Paddle sandbox key, not a live key)
- `PADDLE_WEBHOOK_SECRET`
- `PESAPAL_SANDBOX_CONSUMER_KEY`
- `PESAPAL_SANDBOX_CONSUMER_SECRET`

Variable:
- `PESAPAL_IPN_ID` (registered sandbox IPN GUID)
- `PESAPAL_CALLBACK_URL` (the exact HTTPS staging callback URL registered with Pesapal)

## What it verifies
- Supabase URL is the approved staging project.
- Paddle API key authenticates against the Paddle sandbox `/event-types` endpoint.
- Every active Paddle price in the staging plan-price table exists in Paddle sandbox, is active, and matches the server-configured amount and currency.
- Pesapal credentials obtain a sandbox access token.
- The configured Pesapal IPN ID is present in the merchant's registered sandbox IPN list.
- At least one active Pesapal plan price exists and is UGX.

The runner pins Paddle to `https://sandbox-api.paddle.com` and Pesapal to `https://cybqa.pesapal.com/pesapalv3`. It never accepts production endpoints. It does not create a checkout, submit an order, initiate a payment or charge a customer. It prints only pass/fail status and counts, never credential values or provider response bodies.

## Limits
A pass verifies sandbox API access, price mappings and IPN registration. It does not prove the merchant has completed a real sandbox payment, that provider dashboard webhook destinations are correctly configured, or that production settlement is approved. The provider webhook secret is checked for presence only; signed webhook acceptance remains covered by local signature tests and the webhook event integration suite.

## Exact Pesapal callback route

The Render staging service is `https://executive-visuals-cloud-staging.onrender.com`. The application registers Pesapal IPNs at:

`https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal`

This is the implemented HTTPS GET handler in `server/index.mjs`. Do not register the homepage or the obsolete `/api/billing/pesapal/ipn` path. The acceptance scripts reject callback URLs that do not use `/api/webhooks/pesapal`.

## Separate GitHub acceptance credentials from Render runtime configuration

The GitHub staging workflow intentionally uses sandbox-specific names for its read-only credential checks. The running application uses these server-only Render environment names:

- `PADDLE_PESAPAL_BILLING_ENABLED=false` until isolated schema and end-to-end acceptance are approved
- `PADDLE_API_BASE_URL=https://sandbox-api.paddle.com`
- `PADDLE_API_KEY` (same sandbox API key stored in GitHub as `PADDLE_SANDBOX_API_KEY`)
- `PADDLE_WEBHOOK_SECRET` (the secret for this exact Paddle destination)
- `PADDLE_ALLOW_LIVE=false`
- `PADDLE_RETURN_URL` (verified HTTPS application return route; do not guess)
- `PESAPAL_API_BASE_URL=https://cybqa.pesapal.com/pesapalv3`
- `PESAPAL_CONSUMER_KEY` (same sandbox key stored in GitHub as `PESAPAL_SANDBOX_CONSUMER_KEY`)
- `PESAPAL_CONSUMER_SECRET` (same sandbox secret stored in GitHub as `PESAPAL_SANDBOX_CONSUMER_SECRET`)
- `PESAPAL_IPN_ID` and `PESAPAL_CALLBACK_URL`
- `PESAPAL_ALLOW_LIVE=false`
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the server-side subscription ledger

The application currently checks `SUPABASE_SERVICE_ROLE_KEY` for this billing integration. Do not assume that setting only `SUPABASE_SECRET_KEY` is sufficient. Keep all runtime values server-side in the staging service environment; never add them to Vite/browser variables or source control. Keep billing disabled until the isolated staging migration and all provider acceptance tests pass.
