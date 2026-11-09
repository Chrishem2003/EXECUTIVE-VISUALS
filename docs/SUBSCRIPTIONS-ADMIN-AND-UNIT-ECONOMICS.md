# Executive Visuals — subscriptions, admin and sustainable unit economics

**Status:** Product architecture and implementation backlog, not a live billing integration.  
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


## Cloud subscription entitlement implementation — staging only

The cloud PostgreSQL entitlement foundation is now source-controlled in
`20261109260000_cloud_subscription_entitlements.sql`:

- A versioned plan catalogue for Free, Creator, Studio and Enterprise.
- Subscription records with provider identity, billing period, lifecycle state,
  cancellation-at-period-end and grace-period fields.
- A unique subscription-period grant ledger, preventing duplicate monthly or
  annual credit allocations on webhook retries.
- Recurring subscription periods can advance on the same provider subscription
  identity; stale period updates are rejected and repeated renewal deliveries
  are idempotent.
- A service-role-only activation RPC and period-credit grant RPC.
- A default Free subscription provisioned for new and existing cloud credit
  accounts. Free includes local editing but does not authorize paid video
  generation.
- The cloud generation-credit reservation RPC checks video-generation
  entitlement and customer-credit balance atomically. Scheduled cancellation
  retains access through the already-paid period; past-due access is bounded
  by its grace deadline.
- Creator, Studio and Enterprise entries are catalogue templates only:
  prices are unset, period credits are zero, and checkout is disabled. No
  customer-facing paid offer is represented as live.

The new `cloud-subscription-ledger.mjs` client exposes the server-side
subscription activation and period-credit grant RPCs. It does not itself
declare a payment successful; only a separately verified provider event may
call activation.

PostgreSQL integration checks cover default-Free provisioning, Free-plan
video-generation denial, verified plan activation, idempotent period credits,
Creator generation reservation, and access during scheduled cancellation.
Node tests cover service-role RPC routing, validation, idempotent grants and
secret redaction.

**Still gated:** provider webhook-to-cloud activation wiring, payment
verification in sandbox, renewal event ordering, cancellation/past-due
reconciliation, plan pricing and credit allocation approval, and production
migration/deployment. No live payment collection is enabled.


## Verified Dodo → cloud subscription synchronization

Verified Dodo subscription activation and renewal events now enqueue a durable
local outbox record in the same SQLite transaction as the local subscription
and credit-ledger update. A separate worker mirrors that record to the
Supabase `executive_visuals` schema using the service-role-only subscription
activation and period-credit RPCs.

- The outbox is unique by provider + webhook event ID.
- It stores only the owner, mapped plan code, provider subscription/customer
  IDs, billing period, verified event ID and bounded reconciliation metadata.
- Activation and period-credit grant are separate idempotent calls. If the
  worker stops after activation, retry safely replays activation before
  granting the period credits.
- Failed cloud synchronization is retained with an attempt count and a
  retryable error code; the Dodo webhook is not reprocessed or double-credited.
- The worker runs only when both Supabase URL and service-role credentials are
  configured. No credentials are committed.

Current scope is Dodo activation and renewal. Provider cancellation, pause,
past-due and plan-change state synchronization, Flutterwave recurring
subscription events, payment sandbox verification and production activation
remain separate gates. This does not enable checkout or live payment
collection by itself.


## Provider subscription lifecycle synchronization

A separate service-role-only PostgreSQL RPC now mirrors verified Dodo lifecycle
events without invoking the period-credit grant operation. The durable outbox
supports distinct `activate` and `status` actions, so cancellation, pause,
past-due, recovery, expiry and plan changes cannot accidentally allocate a
second period of credits.

- Dodo lifecycle updates and their outbox records commit in the same local
  transaction as the local subscription state change.
- The cloud status RPC updates lifecycle state, optional plan mapping,
  scheduled-cancellation state and past-due grace deadline.
- Provider event IDs are retained in cloud metadata; exact status-event retries
  return an idempotent receipt.
- A scheduled cancellation can remain active through the current paid period;
  an immediate cancellation, pause or expiry removes generation entitlement
  according to the cloud reservation policy.
- PostgreSQL integration coverage checks pause, past-due grace, recovery and
  duplicate status-event handling.

Flutterwave recurring subscription lifecycle integration and live provider
sandbox verification remain separate work. This migration is not applied to
production by this PR.


## Flutterwave recurring subscription checkout

Flutterwave recurring subscriptions are now available as a separate card-based
checkout path. Each active monthly/yearly application plan maps to a
pre-created Flutterwave Payment Plan using
`FLW_PAYMENT_PLAN_ID_<PLAN_CODE>` (uppercase plan code with punctuation
normalized to underscores). The platform never creates or changes merchant
payment plans automatically.

Required environment gates:

- `FLW_SUBSCRIPTIONS_ENABLED=true`
- `FLW_SECRET_KEY` and `FLW_WEBHOOK_SECRET`
- `PUBLIC_APP_URL`
- `BILLING_ENFORCEMENT_ENABLED=true` or `CREDITS_ENABLED=true`
- One matching `FLW_PAYMENT_PLAN_ID_<PLAN_CODE>` for each recurring plan

The first charge is verified server-to-server before local subscription
activation, first-period credit grant and cloud-ledger synchronization. The
provider cancellation webhook updates local and cloud lifecycle state without
granting credits. Authenticated users can retrieve the status of their own
checkout through the recurring-order status endpoint.

**Payment-method limitation:** Flutterwave Payment Plans force card payments.
The Uganda mobile-money option remains available on the separate one-time
checkout; it is not presented as a recurring payment method. Merchant
dashboard configuration and sandbox/live provider verification are still
required before enabling this path in production.

**Renewal reconciliation remains a follow-on gate:** the current batch verifies
and activates the initial recurring charge and mirrors cancellation. A
separate renewal reconciliation path must be validated against actual
Flutterwave recurring-charge payloads before claiming automatic recurring
credit renewal is production-ready.
