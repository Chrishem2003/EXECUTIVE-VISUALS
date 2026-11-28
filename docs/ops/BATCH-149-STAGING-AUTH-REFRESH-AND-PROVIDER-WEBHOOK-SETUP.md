# Batch 149 — Refreshable staging identities and provider webhook setup

## Why

The prior storage acceptance workflows required two static Supabase access JWTs. Supabase access tokens expire, so static JWT secrets make a staging workflow unreliable and force manual rotation. The staging setup guide also did not give the exact Paddle notification destination contract or consistently list all preflight variables.

## Changes

- Storage acceptance now authenticates two disposable staging users at runtime through Supabase Auth's password grant.
- The owner identity is checked against `STORAGE_TEST_OWNER_ID`; the second account must resolve to a different user ID.
- Access tokens remain in process memory and are never logged or returned.
- Both storage acceptance scripts and their workflows now use:
  - `STORAGE_TEST_OWNER_EMAIL`
  - `STORAGE_TEST_OWNER_PASSWORD`
  - `STORAGE_TEST_OTHER_EMAIL`
  - `STORAGE_TEST_OTHER_PASSWORD`
- The strict staging preflight now requires these four account secrets instead of static JWTs.
- The staging setup guide documents the full secret/variable register, the exact staging health URL, the Pesapal IPN callback, and Paddle Sandbox destination URL/description/event contract.

## Paddle Sandbox destination

Create a URL notification destination in the Paddle Sandbox account:

- Description: `Executive Visuals Staging — Paddle subscription webhook`
- URL: `https://executive-visuals-cloud-staging.onrender.com/api/webhooks/paddle`
- Usage: All (platform and simulation events)
- Events: `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `transaction.completed`, `transaction.payment_failed`, `adjustment.created`, `adjustment.updated`

Copy the generated destination endpoint secret key into `PADDLE_WEBHOOK_SECRET`. It is separate from the sandbox API key. The route is implemented as an HTTPS POST endpoint and verifies Paddle's `Paddle-Signature` header.

## Pesapal Sandbox callback

- Callback URL: `https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal`
- Method: GET IPN route.
- `PESAPAL_IPN_ID`: UUID returned by the Pesapal Sandbox merchant IPN registration. The acceptance script verifies that the ID and callback URL are registered to the same sandbox account.

## Tests

The storage round-trip test suite verifies:
- Two runtime password-grant sessions are acquired.
- Owner ID matches the configured staging user.
- Other account is a distinct user.
- Owner upload/read works.
- Other tenant cannot read the object.
- Signed URL stays on the approved staging host and object path.
- Temporary object cleanup is required and cleanup failure is reported.

The readiness unit tests verify that the new account secret names are required and credential values are not included in readiness output.

## Safety

- No real customer accounts or production credentials are used.
- No storage test is executed against production.
- No Paddle or Pesapal provider request is made by this batch.
- No notification destination is created or changed by this batch.
- No checkout, payment, subscription mutation or credit grant is performed.
- No staging or production migration, Render environment change, deploy or service creation is performed.
- Runtime storage, backup, worker and payment acceptance remain gated on the protected GitHub `staging` environment being configured.
