# Batch 77 — Subscription allowance to generation-wallet integrity

**Status:** draft implementation; disposable PostgreSQL CI pending.  
**Base:** Batch 76 exact-head verified at `3a62e9a38eeeb734576db6f78fed24489304d61c`.

## Finding

The subscription payment finalizers and the generation wallet were not fully aligned for legacy Flutterwave manual renewals:

- Subscription activation/renewal finalizers write grants to the legacy `credit_ledger`.
- Generation jobs consume `billing_credit_ledger`.
- Batch 71 already mirrors verified payment-linked legacy grants into the generation wallet and registers their revenue provenance.
- Paddle/Pesapal and initial Flutterwave purchase paths create the legacy grant; the Flutterwave manual-renewal finalizer advances the paid period but does not create the corresponding allowance grant.

A second wallet mirror would double-credit customers, so Batch 77 deliberately reuses Batch 71's existing mirror and revenue-source trigger.

## Changes

- Adds a database trigger on provider-backed `subscription_events` for `activated` and `renewed`.
- Requires a matching owner, provider, successful payment, verified timestamp, payment purpose and subscription reference.
- Normalizes the legacy Flutterwave `renewal_applied` marker to the common `subscription_applied` marker only after verified payment checks.
- Ensures one legacy included-credit grant per payment, using the established subscription purchase/renewal idempotency keys.
- Existing Batch 71 logic mirrors that grant once into `billing_credit_ledger` and records it as `pending_subscription_split`; the full subscription charge is never assumed to be generation revenue.
- Adds a disposable PostgreSQL integration test for the legacy renewal path and duplicate event delivery.

## Safety and rollout

- No new wallet mirror, no double credit path, no changes to provider payment verification, no checkout activation and no public plan activation.
- No historical balance backfill. Existing customer balances must be reconciled separately before production rollout; do not infer remaining old-wallet balances from gross historical grants.
- No provider API calls, live payments, production migration or deployment.
- Proposed USD plan prices remain draft hypotheses with zero included credits until cost and revenue-split validation is approved.

## Verification

The Billing self-service workflow applies Batch 77 after Batch 71 on disposable PostgreSQL and runs:

- `scripts/subscription-credit-wallet-bridge-postgres-integration-batch-77.sql`
- `npm run verify:subscription-credit-wallet-bridge`

Full Billing self-service, Financial Intelligence and Quality Checks must pass at the exact PR head before promotion.
