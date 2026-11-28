# Batch 145 — Payment webhook end-to-end acceptance

## Scope

This batch verifies the actual provider adapters and subscription-billing orchestration together using deterministic provider responses. It does not create live transactions, grant real credits, change production configuration, or enable payment collection.

## Paddle acceptance

The automated acceptance uses the real `createPaddleSubscriptionProvider` implementation and a correctly generated `Paddle-Signature` header over the exact raw request body.

It verifies:

- HMAC-SHA256 signature verification against the configured endpoint secret.
- Rejection of a tampered raw body before any database write.
- Normalization of a `transaction.completed` event, including the transaction ID, subscription ID, customer ID, server-mapped price, subtotal, currency and checkout custom data.
- Durable webhook-event persistence and database lease claim before settlement.
- Finalization only against the matching pending payment reservation.
- An identical replay is acknowledged without repeating settlement.
- Reuse of an event ID with changed normalized content is rejected before claiming or settlement.
- An early `subscription.created` event is quarantined for review when no internal subscription mapping exists, then reconciled after the verified checkout transaction creates the internal subscription.

The application fulfills paid checkout on `transaction.completed`; the Paddle lifecycle simulator may also emit `transaction.paid`, `subscription.created` and `subscription.activated` in sequence. The adapter intentionally does not treat `transaction.paid` alone as final fulfillment.

## Pesapal acceptance

The automated acceptance uses the real `createPesapalSubscriptionProvider` implementation and a simulated API transport:

1. The provider authenticates against the Pesapal sandbox token endpoint.
2. The GET IPN notification is treated as a signal only; it is not trusted as proof of payment.
3. The application queries Pesapal's authoritative `GetTransactionStatus` endpoint using the tracking ID.
4. Merchant reference, completed status, expected amount and currency are checked against the pending reserved UGX payment.
5. Only the verified matching payment reaches the subscription purchase finalizer.

No live Pesapal endpoint or credential is used by the automated tests.

## CI

The Payment provider sandbox acceptance workflow now runs:

- Existing static sandbox credential and callback checks.
- Existing provider-specific acceptance tests.
- `server/tests/provider-subscription-billing.test.mjs`, including the Batch 145 full-flow tests.

## Manual Paddle sandbox simulation

After the staging destination is configured and the staging service has the matching `PADDLE_WEBHOOK_SECRET`:

1. Open Paddle Sandbox → Developer Tools / Events → Simulations.
2. Create or select the subscription-created scenario.
3. Select the exact staging notification destination.
4. Enable the scenario's supported subscription and transaction lifecycle events, including `subscription.created`, `subscription.activated`, `transaction.paid` and `transaction.completed`.
5. Run the simulation.
6. Inspect each delivery and the HTTP response in Paddle's simulation run details and destination logs.
7. Confirm that the application records the signed event, settles only the matching reserved sandbox payment and does not double-grant on replay.

The simulator is a provider-side manual acceptance step; CI does not claim that the user's Paddle destination or Render service has been exercised.

## Required staging configuration

The Render staging runtime requires the application variable names:

- `PADDLE_API_BASE_URL=https://sandbox-api.paddle.com`
- `PADDLE_API_KEY` (sandbox API key)
- `PADDLE_WEBHOOK_SECRET` (secret generated for this exact Paddle destination)
- `PADDLE_ALLOW_LIVE=false`
- `PADDLE_PESAPAL_BILLING_ENABLED=false` until all staging migrations and end-to-end checks are approved

Pesapal uses:

- `PESAPAL_API_BASE_URL=https://cybqa.pesapal.com/pesapalv3`
- `PESAPAL_CONSUMER_KEY`
- `PESAPAL_CONSUMER_SECRET`
- `PESAPAL_IPN_ID`
- `PESAPAL_CALLBACK_URL=https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal`
- `PESAPAL_ALLOW_LIVE=false`

All provider credentials remain server-side. Do not place them in browser-exposed Vite variables, commits, test fixtures, or logs.

## Acceptance boundary

Passing CI proves the application adapter/orchestration contract against deterministic simulated provider responses. It does not prove that:

- the staging Render service has the current code deployed;
- the user's real Paddle destination is correctly configured;
- the destination secret is installed in Render;
- the Supabase staging migrations have been applied;
- a provider simulation has reached the public staging URL;
- production PostgreSQL, backups, monitoring or dedicated worker are ready.

Those remain separate staging/operational acceptance gates. No production enablement or deployment is authorized by this batch.
