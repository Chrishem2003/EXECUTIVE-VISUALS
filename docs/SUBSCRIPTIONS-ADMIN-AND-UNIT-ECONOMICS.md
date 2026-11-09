# Executive Visuals — subscriptions, admin and sustainable unit economics

**Status:** Architecture plus a development-branch subscription/entitlement foundation. Not a live recurring billing integration.  
**Budget constraint:** $0/month infrastructure budget. No paid services, plans, payment accounts or provider credits are activated by this document.

## Commercial product model

Executive Visuals should sell a subscription to the production workspace, not unlimited access to variable-cost generation.

Separate the following balances and entitlements:

1. **Subscription entitlement:** access to projects, editor tools, storage limits, collaboration, support and administrative features.
2. **Generation credits:** prepaid or included usage units reserved before a provider request and settled after the provider returns a result.
3. **Provider cost:** actual provider charge, tracked separately from the customer-facing credit price.
4. **Local editing usage:** FFmpeg operations with explicit limits on duration, file size, concurrency and storage.

Do not offer unlimited AI video generation. Model prices vary by model, duration, resolution, references and optional audio. A subscription price must be validated against actual provider costs, payment fees, taxes, failed-job behaviour, storage and support before sale.

## Suggested plans — draft only

| Plan | Workspace entitlement | Generation policy |
|---|---|---|
| Free | Personal projects, basic local editor, limited uploads and exports | No platform-funded paid generations; allow only explicitly configured user-funded/BYOK usage |
| Creator | More projects, larger storage allowance, full timeline tools and production templates | Monthly included credits with strict model and spend caps |
| Studio | Team seats, shared projects, approvals, brand kits and collaboration | Larger credit allocation and team usage budgets |
| Enterprise | Admin controls, audit exports, SSO/integration options and support | Contracted credit pool, model allowlists and organization spend caps |

Prices and credit quantities remain unset until provider pricing, payment fees, taxes and storage economics are tested. Never show invented prices as live subscription offers.

## Admin control plane

Required owner/admin capabilities:

- Account search, role changes, suspension and reactivation.
- Plan catalogue and entitlement versioning.
- Manual subscription grants with reason, expiry and audit event.
- Credit grants, expiry, adjustments and immutable transaction ledger.
- Per-user, per-project and per-organization usage limits.
- Provider/model allowlists, feature flags and kill switches.
- Model pricing snapshots with source, currency, effective date and verification status.
- Job, provider failure, refund and charge reconciliation.
- Audit log with actor, action, target, reason and timestamp.
- Support tools that never reveal provider API secrets or other users' private media.

Suggested roles: owner, platform admin, billing admin, support, editor, reviewer and member. A support role must not inherit billing or secret-management permissions.

## Credit ledger invariants

- Reserve credits transactionally before dispatch.
- Use an idempotency key unique to the user, job and generation attempt.
- Settle against actual provider cost when returned; do not infer cost from a model name alone.
- Refund reservations for provider failures only after checking provider charge/refund semantics.
- Keep an immutable append-only ledger; corrections are compensating entries, never row edits.
- Reject a generation if the account is suspended, subscription is inactive, model is not entitled, spend cap is reached, provider is not ready, or the reserve cannot be committed.
- Enforce concurrency and rolling usage limits server-side, not only in the browser.
- Separate provider cost from platform credits and preserve an auditable margin calculation.

## Payment research for Uganda

The first provider candidate is Flutterwave because its current Uganda documentation lists UGX card and mobile-money methods, including MTN/Airtel mobile money. Flutterwave also documents payment plans and subscription lifecycle webhooks. The recurring-payment method and currency availability must be confirmed with the merchant account before launch; do not assume mobile-money recurring debits are supported just because one-time mobile-money collections are supported.

Pesapal is a reasonable second candidate: its Uganda merchant information advertises API integration, and its API 3.0 documentation describes recurring card payments. Stripe's global availability list does not currently list Uganda as a directly supported merchant country.

No merchant account, payment plan, payment API key or live transaction is created by this work.

## Implementation order

### P0 — commercial safety foundations
1. Implement plan and entitlement schemas, seeded with non-billable development defaults.
2. Implement immutable credit ledger and atomic reservations.
3. Implement provider cost/pricing registry with dated source evidence and unknown-cost fail-closed behaviour.
4. Add owner/admin roles and audited admin actions.
5. Add a usage console for user and administrator views.

### P1 — payment integration in sandbox
1. Add Flutterwave checkout in test mode, transaction verification and signed webhook handling.
2. Add subscription activation, renewal, cancellation, grace period and failed-payment states.
3. Add one-time UGX mobile-money credit top-ups separately from recurring subscription billing.
4. Add idempotent payment event processing and reconciliation.
5. Add Pesapal adapter only after the Flutterwave flow is tested.

### P2 — paid launch gates
1. Verify business onboarding, payout destination, tax and refund policies.
2. Verify durable storage, retention and deletion controls.
3. Complete multi-user isolation and billing abuse tests.
4. Reconcile provider invoices against credit consumption and gross margin.
5. Publish clear plan terms, model costs, usage limits and cancellation process.
6. Require explicit owner approval before switching payment mode from sandbox to live.

## Official payment references

- Flutterwave payment plans: https://developer.flutterwave.com/docs/payment-plans-1
- Flutterwave Uganda payment methods: https://developer.flutterwave.com/docs/payment-methods
- Flutterwave Uganda mobile money: https://developer.flutterwave.com/docs/uganda
- Flutterwave Uganda pricing: https://flutterwave.com/ug/pricing
- Pesapal recurring payments: https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/recurringpayments
- Stripe country availability: https://stripe.com/global


## Implementation checkpoint — 2026-11-10

The development branch now contains the first subscription foundation:

- Versioned plan catalogue and immutable entitlement snapshots.
- Customer subscription state and subscription event audit trail.
- One public non-billable Free plan only; paid plan prices and credit allowances remain unset.
- Owner-scoped subscription and plan read APIs.
- Owner/billing-admin-only manual grant API backed by an audited SQL RPC.
- No automatic Flutterwave recurring charge, cancellation, renewal or failed-payment state machine is activated yet.

Flutterwave's Payment Plans documentation explicitly says that attaching a plan fixes the payment method to card. It also documents email-bound subscriptions, three additional retry attempts at 30-minute intervals, and cancellation after repeated failures. Uganda's MTN/Airtel MoMo guide describes one-time authorization, not recurring MoMo. The first recurring integration should therefore be card-only where enabled on the approved merchant account; do not market MoMo auto-renewal without written provider confirmation. See the official references below.

**Release gate:** execute the new migration and API tests in isolated staging; then implement provider-backed subscription lifecycle events and verify renewal/cancellation/recovery. Do not expose paid plans until the merchant's recurring method, settlement and unit economics are verified.
