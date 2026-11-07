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
