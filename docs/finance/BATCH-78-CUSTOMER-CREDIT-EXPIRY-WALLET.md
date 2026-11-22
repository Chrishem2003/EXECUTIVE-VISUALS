# Batch 78 — Customer credit wallet and subscription expiry

**Status:** draft implementation; disposable PostgreSQL verification required.  
**Base:** Batch 77 subscription-credit bridge at `3e720fad493d375f0f712de4164f6fefd7c5663a`.

## Scope

Batch 78 makes customer generation-credit balances period-aware without changing the proposed public subscription prices or activating checkout.

### Credit-lot rules

- Subscription allowances inherit the verified `period_end` recorded on their legacy payment-linked credit grant.
- Purchased credit packs do not expire.
- Promotional, compensation and unattributed grants do not inherit subscription expiry.
- Existing subscription-source expiry metadata is backfilled only when the exact payment-linked legacy grant contains a period end. This metadata-only update does not change wallet balances.

### Expiry safety

- Expiry is recorded as a negative, append-only `expiry` wallet-ledger entry with a unique source idempotency key.
- Only the unconsumed remainder of an allowance expires; prior settled consumption remains attributed to its original source.
- Duplicate expiry sweeps cannot debit a source twice.
- Accounts with any open generation reservation defer expiry. This is intentionally conservative because the current reservation schema does not reserve credits by individual source lot.
- The generation reservation RPC performs a due-expiry sweep before checking spendable balance, preventing stale allowances from being spent after their period end.

### Customer wallet read model

The service-role-only wallet RPC returns:
- Available, reserved and consumed credits.
- Credits expiring within seven days.
- Remaining credit lots, source type, expiry and revenue status.
- The latest 100 append-only wallet transactions.

The RPC is ready for a subsequent authenticated customer API/UI integration; this batch does not expose direct database access to customers.

## Verification

The Billing self-service workflow applies Batch 78 after Batch 77 and runs:

- `scripts/customer-credit-expiry-wallet-postgres-integration-batch-78.sql`
- `npm run verify:customer-credit-expiry-wallet`

The integration test checks an allowance with 75 credits, settles 20 credits of a 25-credit reservation, defers expiry while the reservation is open, then expires exactly the remaining 55 credits. It also verifies repeat-sweep idempotency, zero spendable balance after expiry and preservation of purchased packs.

## Rollout safety

- No live provider calls, payment processing or checkout activation.
- No public plan pricing changes.
- No production migration or deployment.
- No historical wallet balance mutation; only expiry metadata is deterministically reconstructed from verified source grant metadata.
- No automatic expiry of older subscription grants whose billing period end cannot be proven.
