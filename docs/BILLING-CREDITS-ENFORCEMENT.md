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
- An exact active registry match is required for `provider + model + capability + unit`. The record must have a positive USD price, an HTTPS source URL and a verification timestamp.
- Video generation passes seconds as the billable quantity; image generation passes one image; voice and text currently pass one request. The registry unit must match exactly.
- The engine rounds up to whole credits and stores the pricing provenance, upstream unit price, quantity, markup and calculated estimate in the ledger metadata.
- If the registry record is missing, unverified, non-USD, or either pricing environment value is absent, the existing flat capability schedule is used. No unsupported FX conversion is guessed.
- Set the credit value and markup only after finance approves actual payment fees, provider costs, currency exposure, refunds and desired gross margin. Never enable enforcement on production based only on example values.

This is a preflight estimate, not provider invoice reconciliation. Actual asynchronous task costs and provider refunds still need settlement reconciliation before commercial launch.

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

The browser return is never proof of subscription activation. A subscription becomes active and credits are granted only after a signed webhook is verified and the subscription product, amount, currency, user, and local plan match. Renewal events grant the next period's credits idempotently; past-due, on-hold, paused, cancelled, and expired events update local subscription status.

Dodo's published merchant policy lists Uganda among accepted merchant countries, but AI content-generation tools are a review category. Dodo requires no impersonation, scraping, deepfakes, face-swap features, or voice cloning. Executive Visuals must receive written approval before the `DODO_MERCHANT_APPROVED` flag is set. No Dodo account, product, API key, webhook endpoint, or live payment was created during this implementation.

Official references:
- Checkout Sessions (recommended for one-time and subscription checkout): https://github.com/dodopayments/skills/blob/main/dodo-payments/checkout-integration/SKILL.md
- Webhook signature verification and delivery: https://docs.dodopayments.com/developer-resources/webhooks
- Subscription event payloads: https://docs.dodopayments.com/developer-resources/webhooks/intents/subscription
- Merchant acceptance policy and AI-content review category: https://docs.dodopayments.com/miscellaneous/merchant-acceptance
- Accepted merchant countries: https://docs.dodopayments.com/miscellaneous/list-of-countries-we-accept-payments-from
