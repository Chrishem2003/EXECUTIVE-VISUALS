# Executive Visuals — owner security and payment activation

This is an operator runbook. It does not enable billing or grant roles automatically.

## 1. Owner account

The designated initial platform owner is `chrishem242@gmail.com`.

1. Configure Supabase Auth for the production/staging project.
2. Register using the owner email and complete the email-verification flow.
3. Apply the reviewed financial-intelligence migrations to the isolated staging Supabase project.
4. Open Supabase Dashboard → SQL Editor while signed in as the trusted project owner.
5. Run `supabase/manual/BOOTSTRAP_PLATFORM_OWNER.sql` exactly once.
6. Confirm the result shows the verified email and role `owner`.
7. Sign in to Executive Visuals again and verify the admin-only financial API returns access only for this account.

The email address is not a password, an API key, or a role-grant mechanism. There is no public owner-registration endpoint. The grant is a manual database operation requiring privileged Supabase dashboard access.

### Required security posture

- Production must use `AUTH_MODE=supabase`; local auth is rejected in production.
- Keep Supabase service-role credentials only in the server's secret environment. Never put them in browser code, Vite variables, public GitHub Actions logs, or a client-side config file.
- Keep `platform_admins` inaccessible to `anon` and `authenticated`; the server's service role reads the table after verifying the Supabase session.
- Do not grant admin from a request body, query parameter, user-editable metadata, email-only allowlist, or front-end route guard.
- Require MFA for the owner in Supabase Auth, use a unique password stored in a password manager, secure the recovery email, and protect the GitHub/Render/Supabase accounts with MFA.
- Keep the admin account separate from everyday customer testing. Review the audit trail for any role change.
- Do not enable refunds, billing, or live provider traffic until the staging acceptance checklist passes.

## 2. Flutterwave merchant onboarding in Uganda

Create or sign in to the official Flutterwave merchant dashboard and complete the Uganda onboarding/KYC flow. Select the account type that truthfully matches the legal status of the business (individual, sole proprietorship, or limited entity).

Flutterwave's Uganda onboarding page lists the relevant identity, business registration, tax, address, website and bank evidence for each account type. Do not submit someone else's identity or bank details.

After approval:

1. Complete live-transaction activation/KYC.
2. Add the business settlement bank account in the Flutterwave dashboard and verify the beneficiary details.
3. Confirm whether settlements go directly to the bank account or to the Flutterwave payout balance.
4. Enable the payment methods approved for the account. Uganda supports card and mobile money; mobile-money networks include MTN and Airtel.
5. Start in Test Mode and use only test credentials until the staging tests pass.

Official pages:
- Uganda onboarding: https://www.flutterwave.com/us/support/onboarding/onboarding-requirements-for-using-flutterwave-in-uganda
- Uganda payment methods: https://developer.flutterwave.com/docs/uganda
- Uganda pricing: https://flutterwave.com/ug/pricing
- Settlements: https://developer.flutterwave.com/docs/settlements

## 3. Server-only environment variables

Set these in the Render service's private environment settings, not in Git:

```dotenv
AUTH_MODE=supabase
BILLING_API_ENABLED=false
FLW_REFUNDS_ENABLED=false
FLW_ALLOW_LIVE=false
FLW_API_BASE_URL=https://developersandbox-api.flutterwave.com
FLW_CLIENT_ID=
FLW_CLIENT_SECRET=
FLW_SECRET_HASH=
FLW_WEBHOOK_VERSION=v4
PAYMENT_RECONCILIATION_ENABLED=false
PAYMENT_RECONCILIATION_INTERVAL_MINUTES=60
```

Use the test/sandbox client credentials and webhook secret first. Do not paste credentials into chat, issues, pull requests, screenshots, or commits.

Only after the provider approves the account and staging has passed should an operator explicitly enable live credentials and live mode. Do not change `FLW_ALLOW_LIVE` to true as part of initial setup.

## 4. Webhook setup

Configure the Flutterwave v4 webhook URL to:

`https://executive-visuals.onrender.com/api/webhooks/flutterwave`

Use the exact webhook secret configured in `FLW_SECRET_HASH` and v4 signature mode. The endpoint verifies the raw request body. Do not put an admin email or any secret in the webhook URL.

## 5. Revenue model and payment methods

Suggested product structure for the first commercial release:

- Free: small trial credit allowance; no card required.
- Creator: monthly and annual subscription with a defined included credit allowance.
- Pro: higher monthly/annual allowance, faster queue priority and professional export options.
- Studio: team seats, shared projects and pooled credits.
- Credit top-ups: one-off purchases for customers who exceed their plan allowance.

Treat prices, entitlements and credit grants as server-owned catalogue records. Never accept the price, number of credits, role, or subscription tier from the browser as authoritative.

Ugandan customers should see UGX pricing and the available approved card/mobile-money methods. International card acceptance and any additional currency must be confirmed against the merchant account's approved Flutterwave configuration.

## 6. Checkout and recurring billing architecture

Keep the current Flutterwave v4 integration consistent. Do not bolt the legacy v3 Standard Checkout API onto the existing v4 refund/auth client: Flutterwave documents v3 and v4 as separate API versions and the current integration is built around v4 OAuth.

### One-time purchases
- Use the v4 Orchestrator flow for a single charge, with a server-generated unique reference and idempotency key.
- For Uganda mobile money, collect the customer's email, name and phone, and use the v4 `mobile_money` payment method only after Flutterwave confirms UGX + the selected MTN/Airtel network is enabled for the merchant account.
- For cards, use Flutterwave's v4 encrypted card data / supported authorization flow. Never send raw PAN, CVV, PIN or OTP through Executive Visuals application servers or logs.
- Retrieve the charge from Flutterwave and compare its ID, reference, amount, currency and final status with the pending transaction before recording payment or granting any entitlement.
- Webhook signature verification is necessary but not sufficient. Re-query the charge server-to-server before any fulfilment.

### Recurring subscriptions
- Flutterwave v4 documents card tokenization / recurring charges using a stored payment-method ID and recurring flag. Store only provider-issued payment-method tokens/IDs and masked card metadata; never store card numbers or CVV.
- Flutterwave also documents Credential-on-File as approval-gated. Ask Flutterwave support whether the account is eligible before implementing that option.
- Mobile money is a one-off authorization flow; do not promise automatic MTN/Airtel recurring deductions unless Flutterwave explicitly confirms this for the Uganda merchant account.
- Subscription renewal, grace period, failed-renewal retries, cancellation and entitlement expiry must be controlled by Executive Visuals' own subscription state machine and idempotent webhook/reconciliation handling.
- Before recurring card charges are enabled, obtain explicit customer consent for amount, cadence, cancellation and stored payment method, and have the provider confirm account approval and applicable local requirements.

Official v4 references:
- General flow: https://developer.flutterwave.com/v4.0.0/docs/main-payment-flow
- Orchestrator flow: https://developer.flutterwave.com/v4.0.0/docs/payment-orchestrator-flow
- Uganda mobile money: https://developer.flutterwave.com/docs/uganda
- Card payments and tokenization: https://developer.flutterwave.com/v4.0/docs/card
- Webhooks: https://developer.flutterwave.com/v4.0/docs/webhooks

### Settlement destination
The merchant must complete KYC and be approved for live transactions. In the Flutterwave dashboard, configure settlement destination as the F4B wallet / payout balance rather than bank settlement. Keep the bank or eligible withdrawal beneficiary information available for later withdrawals if Flutterwave requests it. The dashboard controls the merchant settlement destination; Executive Visuals does not redirect merchant settlements.

## 7. Go-live acceptance gates

- Owner account is verified and manually granted the owner role.
- MFA is enabled on the owner and provider accounts.
- Staging admin authorization tests prove a normal customer cannot access financial admin endpoints.
- Browser bundle and public health output contain no secret values.
- Checkout amounts and credit entitlements are calculated server-side.
- Provider charge ID, transaction reference, amount and currency are verified server-to-server before granting credits.
- Webhook signatures, duplicate delivery, retries and reconciliation are tested.
- Refunds reverse only the credits actually granted for the original payment.
- Customer invoices, cancellation and failed-payment handling are tested.
- Settlement bank account is confirmed in the Flutterwave dashboard.
- Live mode remains disabled until the operator approves a separate production change.

## 8. Manual reconciliation of Flutterwave subscription cancellations

Signed `subscription.cancelled` callbacks are retained in the administrator reconciliation queue. They do not automatically change customer access because the provider payload may not identify a local subscription unambiguously.

An owner, platform administrator or billing administrator can resolve an event only after checking both:
- the exact provider subscription ID in the signed event matches the stored `provider_subscription_id`;
- the provider customer email matches the local subscription's customer email.

Use the administrator reconciliation endpoint to submit the webhook event ID, local subscription ID and a short review reason. The database performs the identity checks, cancellation, webhook status transition and append-only subscription event in one transaction. Replays are idempotent. Missing or mismatched provider identity/email remains in `needs_review`; no entitlement change is made. Do not manually populate provider subscription IDs from an unverified email or plan name.

This workflow is available only in billing-enabled staging. It does not enable recurring charges, live billing or automatic cancellation from ambiguous callbacks.
