# Batch 146 — Subscription entitlement and financial reconciliation

## Objective

Make subscription/payment drift visible and auditable before paid launch. The reconciliation RPC is read-only with respect to customer payment, subscription, entitlement and credit ledgers. It records a durable report run, but never silently repairs financial records or grants credits.

## Implemented

- `executive_visuals.run_subscription_financial_reconciliation(integer)` performs bounded, read-only checks and persists each report in `subscription_financial_reconciliation_runs`.
- Report history is protected by RLS. Direct client access is revoked; only the server-side `service_role` can read history and execute the RPC.
- The default report returns up to 100 findings; accepted limit is 1–500.
- Findings include:
  - `successful_payment_not_applied`
  - `applied_payment_not_successful`
  - `subscription_record_missing`
  - `subscription_provider_mismatch`
  - `subscription_allowance_grant_missing`
  - `subscription_allowance_wallet_mirror_missing`
  - `active_subscription_period_elapsed`
  - `past_due_grace_deadline_missing`
  - `multiple_current_subscriptions`
  - `stale_pending_subscription_without_pending_payment`
- Findings carry internal owner/payment/subscription identifiers for privileged remediation, but do not expose customer email, credentials, provider secrets or payment-method data.
- Paddle `subscription.past_due` lifecycle events now establish a non-extendable 72-hour grace deadline from the provider's signed `occurred_at` timestamp. Repeated deliveries cannot extend the deadline; a verified resume clears it.
- PostgreSQL integration coverage verifies a clean Paddle/Pesapal baseline, durable run history, successful-but-unapplied payment detection, missing grace detection, expired active subscription detection, and the Paddle grace deadline.

## Operational invocation

Call the PostgREST RPC from a trusted server-side job using the Supabase service key:

```http
POST /rest/v1/rpc/run_subscription_financial_reconciliation
Content-Type: application/json
Accept-Profile: executive_visuals
Content-Profile: executive_visuals

{"p_limit":100}
```

The service key must never be exposed to browser code. Store the returned `runId`, `findingCount`, and findings in the privileged finance operations workflow. Review findings before making any correction.

## Financial safety boundaries

- No credits are granted or revoked by reconciliation.
- No payment is marked successful or failed by reconciliation.
- No subscription status or grace deadline is changed by reconciliation.
- No provider API is called and no refund, cancellation or charge is initiated.
- Findings are evidence for an authorized operator; any remediation must use the existing verified, idempotent payment and subscription RPCs.
- Subscription allowance revenue remains `pending_subscription_split` until an authorized financial administrator approves the revenue component. A subscription's full cash payment is never automatically recognized as generation revenue.

## CI / staging acceptance

The Billing self-service PostgreSQL workflow applies this migration only after the existing Paddle/Pesapal provider integration and Batch 71 credit-revenue allocation migrations. It then runs `scripts/subscription-financial-reconciliation-postgres-integration-batch-146.sql` in the disposable PostgreSQL service container. The integration script wraps all fixture mutations and reconciliation runs in a transaction and rolls them back.

CI acceptance does not apply this migration to the user's Supabase staging or production database, nor does it prove a deployed Render service is calling the RPC.
