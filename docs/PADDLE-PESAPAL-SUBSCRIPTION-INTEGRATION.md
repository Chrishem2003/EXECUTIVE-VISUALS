# Paddle primary + Pesapal secondary subscription integration

**Status:** provider adapter foundation, sandbox-only by default. Not enabled for customer checkout until the unified subscription ledger and webhook application path are connected and verified.

## Provider roles

- **Paddle:** primary international SaaS subscription provider. Use a server-side plan-code-to-Paddle-price-ID map. Create hosted transactions with owner and plan metadata. Only verified Paddle webhooks may activate, renew, suspend or cancel entitlements.
- **Pesapal:** secondary Uganda/East Africa checkout provider. Supports local payment methods and tokenized recurring card schedules where enabled for the merchant. Its documented recurring schedule flow is card-based (Visa/Mastercard); do not advertise recurring MTN/Airtel Money debits. Mobile-money orders, where supported by the merchant account, must be treated as one-time payments/manual renewals unless Pesapal confirms otherwise in writing.
- Both adapters return normalized provider events. The subscription ledger, not either adapter or the browser return page, remains the source of truth for access.

## Server-only environment

Paddle sandbox:
- PADDLE_API_KEY
- PADDLE_WEBHOOK_SECRET
- PADDLE_API_BASE_URL=https://sandbox-api.paddle.com
- PADDLE_ALLOW_LIVE=false
- PADDLE_PRICE_ID_<PLAN> for each sellable plan (the application must map these values server-side).

Pesapal sandbox:
- PESAPAL_CONSUMER_KEY
- PESAPAL_CONSUMER_SECRET
- PESAPAL_API_BASE_URL=https://cybqa.pesapal.com/pesapalv3
- PESAPAL_ALLOW_LIVE=false
- Register the HTTPS IPN endpoint once and store its returned ipn_id in server configuration.

Never put these values in Vite/browser variables, source control, client responses or logs. Live mode requires a deliberate environment change and separate merchant approval.

## Adapter contracts

server/subscription-payment-providers.mjs exports:
- createPaddleSubscriptionProvider
- createPesapalSubscriptionProvider
- createSubscriptionPaymentProviders

Paddle:
- Uses the documented sandbox/live API hosts only.
- Uses server-mapped pri_ price IDs; ignores client-supplied prices.
- Creates hosted checkout transactions with owner_id and plan_code custom data.
- Verifies the Paddle-Signature header against the exact raw request body, timestamp and configured endpoint secret, with a five-minute replay window.
- Normalizes known subscription and transaction events. Unknown event types are acknowledged as ignored by the adapter and must not change access.

Pesapal:
- Uses the documented sandbox/live API hosts only.
- Authenticates with the merchant consumer key and secret and caches the short-lived access token in process memory.
- Registers an HTTPS GET IPN endpoint and creates hosted orders.
- For recurring schedules, passes subscription details to the hosted iframe so the payer can explicitly consent. Pesapal's recurring IPN is only a notification; the adapter calls GetTransactionStatus and checks merchant reference, successful status, amount and currency before returning a normalized event.
- Do not infer a recurring subscription solely from a checkout redirect or an unverified IPN query.

## Required next integration before staging activation

1. Add provider IDs to the dedicated Executive Visuals subscription/payment schema, with unique constraints for provider event IDs, provider transaction IDs and provider subscription IDs.
2. Add a server-side checkout reservation RPC that locks the internal plan price and creates a pending subscription/payment record before calling a provider. Never trust client amount, currency or provider price ID.
3. Add an inbox/outbox lifecycle processor. Verify signatures/status first; persist every event idempotently; handle duplicate and out-of-order events; apply renewals/cancellations atomically; reconcile ambiguous events instead of granting access.
4. Wire authenticated checkout, Paddle webhook and Pesapal IPN routes into the financial API using raw request bodies for Paddle.
5. Add customer portal/session routes and customer-visible subscription status/cancellation semantics.
6. Test using Paddle and Pesapal sandbox merchant accounts, webhook retries, duplicate/out-of-order events, failed renewals, refunds, cancellation and cross-account isolation.
7. Enable provider checkout in staging only after dedicated staging Supabase schema and secrets exist. Keep production billing disabled until explicit approval.

## Verification

Run npm run verify:subscription-payment-providers. Tests use fake provider HTTP responses and no live credentials or network calls.
