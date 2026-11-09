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

## 6. Recurring billing caveat

Flutterwave's published Payment Plans documentation describes recurring card billing and says the plan checkout is card-only. Uganda mobile money is suitable for one-off credit packs, but do not promise automatic recurring MTN/Airtel deductions from that product.

For a subscription-like experience, use one of:
- card-based recurring billing only after Flutterwave confirms the supported v4 recurring/tokenization setup and required merchant approval; or
- manual renewal/one-off MoMo payments with a clear expiry and grace period.

Do not mix Flutterwave v3 Payment Plans with this v4 integration without a deliberate architecture/version decision. Flutterwave's documentation says v3 and v4 are separate API versions and should not be mixed in one integration.

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
