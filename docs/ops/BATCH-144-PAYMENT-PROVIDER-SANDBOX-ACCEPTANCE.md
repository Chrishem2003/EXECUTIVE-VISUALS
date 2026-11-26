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
