# Billing credits and remote generation enforcement

The billing foundation uses **one canonical append-only ledger**: `billing_credit_ledger`. Do not introduce a second balance table for paid generation. The legacy staging-only `credit_accounts` / `credit_ledger` implementation is superseded by this unified ledger when the billing integration is accepted.

## Feature flags

- `BILLING_ENFORCEMENT_ENABLED=true` enables daily free allowances and server-side credit charging before remote provider requests.
- `CREDITS_ENABLED=true` remains a compatibility alias for the existing staging credits flag.
- `CREDITS_DAILY_FREE` sets the UTC daily free allowance; default 20, valid range 0–10,000.
- `BILLING_CHECKOUT_ENABLED=true` enables hosted credit-pack checkout only when credit enforcement is also enabled and all Flutterwave server configuration is present.

No payment collection is enabled by default. Do not enable checkout until the provider merchant account, webhook secret hash, HTTPS return URL, sandbox tests and margin rules are approved.

## Current per-request credit schedule

| Capability | Credits |
|---|---:|
| Text generation, summarization, translation | 1 |
| Voice generation | 2 |
| Voice transcription | 1 |
| Image generation | 3 |
| Video generation | 15 |
| Unknown remote capability | 1 |

These are **customer credit units**, not provider USD costs. They are conservative starter values inherited from the existing staging credit policy. They must be reconciled against verified provider costs, model-specific quality tiers, output duration/resolution, currency conversion, payment fees and target gross margin before public pricing is launched.

### Verified model-price preflight (opt-in)

The billing engine can now use the admin model-price registry before a remote job is submitted:

- `BILLING_CREDIT_VALUE_MICROS` defines the customer value of one credit in USD micros. Example: `10000` means USD $0.01 per credit.
- `BILLING_COST_MARKUP_BPS` sets a markup in basis points on the recorded upstream cost. Default: `5000` (50% markup); valid range: 0–50,000.
- An exact active registry match is required for `provider + model + capability + unit`. The record must have a positive USD price, an HTTPS source URL and a verification timestamp no older than `BILLING_MODEL_PRICE_MAX_AGE_DAYS` (default 30; allowed 1–365). Future-dated or stale records fail closed and must be re-verified.
- Video generation passes seconds as the billable quantity; image generation passes one image; voice and text currently pass one request. The registry unit must match exactly.
- The engine rounds up to whole credits and stores the pricing provenance, upstream unit price, quantity, markup and calculated estimate in the ledger metadata.
- If the registry record is missing, unverified, non-USD, or either pricing environment value is absent, the existing flat capability schedule is used. No unsupported FX conversion is guessed.
- Set the credit value and markup only after finance approves actual payment fees, provider costs, currency exposure, refunds and desired gross margin. Never enable enforcement on production based only on example values.

This is a preflight estimate, not provider invoice reconciliation. Actual asynchronous task costs and provider refunds still need settlement reconciliation before commercial launch.

## Plan entitlement enforcement

- Local private asset uploads are checked against the owning account's `storageBytes` allowance. Project uploads are charged to the project owner's storage pool, including assets uploaded by project members.
- The server checks declared size before writing, enforces the quota while streaming, and rechecks under a SQLite write transaction before committing asset metadata. Failed uploads are deleted.
- Job enqueue enforces `concurrentJobs` atomically across queued, running and review jobs. Terminal jobs release their slots. Idempotent retries return the existing job without consuming another slot.
- These limits are enforced by the core local-storage/job APIs. The separate Supabase cloud workspace still requires isolated staging acceptance and its own quota reconciliation before it can be treated as the production storage system.

## Refund handling

Verified Dodo `refund.succeeded` events are stored idempotently. When the refund maps to a subscription credit grant with a verified original amount and currency, credits are reversed proportionally and cumulatively in the append-only ledger. Reversal uses a stable refund idempotency key; a balance may become negative if the user already spent the refunded credits, which blocks further paid generation.

If the original payment cannot be matched, the amount/currency is missing, or the cumulative refund exceeds the recorded payment, the event is retained in the administrator reconciliation queue instead of silently changing credits. For a user-linked refund that needs manual credit correction, an administrator enters the number of credits to reverse; the server verifies that the amount does not exceed the remaining grants for that payment and creates a negative append-only ledger adjustment, even if the user already spent the credits. Alternatively, the administrator can explicitly document that no credits were granted. Every resolution is audited.

## Administrator finance reporting

The admin overview distinguishes:
- **Verified gross receipts (30 days):** settled one-time top-ups plus processed Dodo subscription activation/renewal events, grouped by currency.
- **Committed MRR (pre-tax):** active monthly subscription value plus one-twelfth of active annual plan value, grouped by currency.
- **Estimated provider cost:** the existing model-usage estimate, not a provider invoice.

These figures are not net revenue or profit. Payment fees, taxes, refunds, chargebacks, FX settlement and actual provider task invoices must be reconciled before publishing profitability or margin figures.

## Enforcement behavior

- Only remote providers consume credits. Local processing remains uncharged.
- A remote usage slot is reserved first; credit failure removes that reservation, so an insufficient-balance request does not consume the daily remote request allowance.
- Daily free credits are added at most once per user per UTC day and expire at the next UTC day boundary. Paid/admin-granted credits are not reduced by the daily allowance.
- Spend uses a per-workflow-node idempotency key. A replay of an already reserved node is blocked before a duplicate provider submission.
- Provider-node failures refund the reserved credits through an idempotent ledger entry. A process crash after provider submission but before result persistence still requires reconciliation; the platform must not assume it can safely replay the provider call.
- The existing remote request cap remains a separate guardrail.

## Checkout and settlement

- Only active one-time credit-pack plans can be purchased through the current Flutterwave checkout.
- UGX one-time top-ups can offer card and Uganda mobile money. Recurring subscriptions are disabled.
- Checkout is feature-flagged and server-side. The browser redirect is informational only.
- Credits are granted only after a signed `verif-hash` webhook is received and the transaction is verified server-to-server for transaction reference, successful status, currency and amount.
- Failed checkout attempts do not close the hosted order because Flutterwave can issue another transaction reference for a customer retry.
- Webhook intake stores only normalized settlement fields, deduplicates retries, and processes asynchronously.

## Still required before public launch

1. Replace starter flat credit prices with provider/model-specific preflight cost estimates and margin controls.
2. Reconcile provider task costs and refunds for asynchronous video tasks.
3. Add renewal, cancellation, failed-renewal, refund and dunning flows before recurring subscriptions are enabled.
4. Reconcile crash-after-submit cases against provider task IDs before allowing retries.
5. Complete staging sandbox tests and finance approval.
6. Use isolated durable Postgres and private object storage with tested backup/restore before charging customers.


## Dodo recurring subscriptions — approval-gated

Dodo Payments is the proposed recurring subscription provider, while Flutterwave remains the Uganda-oriented one-time UGX top-up provider. The Dodo adapter uses hosted Checkout Sessions and Standard Webhooks. It is intentionally disabled unless all of these are explicitly configured:

- `DODO_MERCHANT_APPROVED=true` — set only after written merchant acceptance for Executive Visuals.
- `DODO_SUBSCRIPTIONS_ENABLED=true`
- `BILLING_ENFORCEMENT_ENABLED=true` (or the existing `CREDITS_ENABLED=true` compatibility flag)
- `DODO_PAYMENTS_API_KEY`
- `DODO_PAYMENTS_WEBHOOK_KEY`
- `DODO_PAYMENTS_ENVIRONMENT=test_mode` for staging; `live_mode` only after approval.
- `DODO_PRODUCT_ID_<PLAN_CODE>` for each recurring plan created in the Dodo dashboard.

The browser return is never proof of subscription activation. A subscription becomes active and credits are granted only after a signed webhook is verified and the subscription product, amount, currency, user, and local plan match. Renewal events grant the next period's credits idempotently; past-due, on-hold, paused, cancelled, and expired events update local subscription status. The authenticated billing workspace can create a short-lived, owner-scoped Dodo customer-portal session so customers can manage payment methods, invoices and cancellation in Dodo's hosted portal; the local customer ID is never accepted from the browser. Portal access and billing status remain available to suspended accounts so a user can still cancel an existing paid subscription; suspended accounts cannot start new paid generation or checkout.

Dodo's published merchant policy lists Uganda among accepted merchant countries, but AI content-generation tools are a review category. Dodo requires no impersonation, scraping, deepfakes, face-swap features, or voice cloning. Executive Visuals must receive written approval before the `DODO_MERCHANT_APPROVED` flag is set. No Dodo account, product, API key, webhook endpoint, or live payment was created during this implementation.

Official references:
- Checkout Sessions (recommended for one-time and subscription checkout): https://github.com/dodopayments/skills/blob/main/dodo-payments/checkout-integration/SKILL.md
- Webhook signature verification and delivery: https://docs.dodopayments.com/developer-resources/webhooks
- Subscription event payloads: https://docs.dodopayments.com/developer-resources/webhooks/intents/subscription
- Merchant acceptance policy and AI-content review category: https://docs.dodopayments.com/miscellaneous/merchant-acceptance
- Accepted merchant countries: https://docs.dodopayments.com/miscellaneous/list-of-countries-we-accept-payments-from
- Customer portal sessions: https://docs.dodopayments.com/api-reference/customers/post-customers-customer-id-customer-portal-session


## Immutable provider-usage settlement (local billing ledger)

The local billing engine now exposes `settleBillingSpend` for post-execution
reconciliation against authoritative provider evidence. It does not edit or
delete the original `generation_spend` row. Instead, one transaction inserts
a unique settlement record and, only when the actual credit amount differs
from the preflight charge, one compensating append-only ledger entry:

- Actual usage below the estimate creates a positive `generation_refund`.
- Actual usage above the estimate creates an additional negative `generation_spend`.
- Equal usage records a settlement without adding a zero-value ledger row.
- The original spend can be settled only once; both the original spend and
  settlement idempotency keys are protected against conflicting retries.
- A repeated identical settlement returns the stored result. A different
  actual amount, spend, or settlement key is rejected as a conflict.
- Evidence is mandatory and typed as a provider task receipt, provider invoice,
  provider usage reconciliation, or verified no-charge cancellation. The
  stored evidence is bounded to provider, evidence type, evidence ID, and
  optional task/invoice references.

The adjustment and settlement record commit atomically. If the provider's
verified actual usage exceeds the estimate, the difference is debited even if
that makes the current balance negative; further generation remains subject
to the ordinary balance check. This prevents the platform from silently
absorbing unestimated provider cost.

**Scope limitation:** this is a tested local SQLite billing-ledger primitive.
It is not yet wired into the Supabase cloud workflow approval/enqueue
transaction or a live provider callback. Cloud customer-credit reservation,
provider invoice ingestion, and cross-ledger reconciliation remain release
gates. No production billing flag or payment collection is enabled by this
change.
