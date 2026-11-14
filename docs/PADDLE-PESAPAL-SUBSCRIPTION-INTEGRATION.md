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
- Verifies the Paddle-Signature header against the exact raw request body, timestamp and configured endpoint secret, with a five-second replay tolerance and support for multiple signatures during endpoint-secret rotation.
- Normalizes known subscription and transaction events. Unknown event types are acknowledged as ignored by the adapter and must not change access.

Pesapal:
- Uses the documented sandbox/live API hosts only.
- Authenticates with the merchant consumer key and secret and caches the short-lived access token in process memory.
- Registers an HTTPS GET IPN endpoint and creates hosted orders.
- The current checkout intentionally omits `account_number` and `subscription_details`, so it does not offer an automatic recurring schedule before the renewal ledger is ready. Pesapal recurring card schedules can be enabled in a later slice after recurring IPNs can reserve and atomically settle renewal ledger entries. Pesapal IPNs are only notifications; the adapter calls GetTransactionStatus and checks merchant reference, successful status, amount and currency before returning a normalized event.
- Do not infer a recurring subscription solely from a checkout redirect or an unverified IPN query.

`supabase/migrations/20261121120000_paddle_pesapal_provider_billing.sql` extends the existing payment and subscription ledger to accept both providers, adds provider-specific plan prices, and adds service-role-only reservation and initial-purchase finalization RPCs. Paddle prices are separate from Pesapal UGX prices, so no unsafe currency assumption is made.

`server/unified-subscription-billing.mjs` provides provider-neutral checkout and event orchestration. It reserves the internal subscription before checkout, reuses idempotent checkout records, carries the reserved price/payment identity to Paddle, retains uncertain provider outcomes for reconciliation, and delegates verified events to an atomic repository method. The concrete Supabase repository, recurring-renewal processor and HTTP routes are not wired yet.

## Required next integration before staging activation

1. Apply and validate the new provider-ledger migration in an isolated Supabase preview/staging database; add explicit staging provider prices and verify unique provider transaction/subscription identities.
2. Implement the concrete Supabase repository and wire authenticated checkout to `reserve_subscription_purchase_for_provider`; keep all plan price, currency and Paddle price-ID decisions server-side.
3. Add an inbox/outbox lifecycle processor. Verify signatures/status first; persist every event idempotently; handle duplicate and out-of-order events; apply renewals/cancellations atomically; reconcile ambiguous events instead of granting access.
4. Wire authenticated checkout, Paddle webhook and Pesapal IPN routes into the financial API using raw request bodies for Paddle.
5. Add customer portal/session routes and customer-visible subscription status/cancellation semantics.
6. Test using Paddle and Pesapal sandbox merchant accounts, webhook retries, duplicate/out-of-order events, failed renewals, refunds, cancellation and cross-account isolation.
7. Enable provider checkout in staging only after dedicated staging Supabase schema and secrets exist. Keep production billing disabled until explicit approval.

## Verification

Run npm run verify:subscription-payment-providers. Tests use fake provider HTTP responses and an in-memory repository; they do not use live credentials or network calls.
