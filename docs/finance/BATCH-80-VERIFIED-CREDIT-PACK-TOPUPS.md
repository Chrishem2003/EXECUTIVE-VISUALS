# Batch 80 — Verified credit-pack top-ups

**Status:** draft implementation; PostgreSQL integration and full CI required.  
**Base:** Batch 79 customer wallet dashboard.

## Gap addressed

The legacy Flutterwave credit-pack finalizer created a paid-credit grant but did not set the Batch 71 provenance markers `payment_purpose=credit_pack_purchase` and `credit_pack_applied=true` before the legacy grant trigger ran. Without those markers, the verified grant could be mirrored as unattributed rather than as a paid credit pack.

## Checkout snapshot

The authenticated checkout endpoint now:
- Requires an active `credit_pack` catalogue product.
- Stores a server-owned immutable snapshot of product code/type, amount, currency and credit units on the pending payment.
- Marks the payment purpose as `credit_pack_purchase` but keeps `credit_pack_applied=false` until server-side provider verification.
- Holds legacy pending idempotency replays without a snapshot for reconciliation instead of issuing another charge.

## Atomic verified settlement

Batch 80 wraps the existing Flutterwave finalizer:
1. Locks the pending payment.
2. Validates the immutable checkout snapshot against the payment amount, currency and credit entitlement.
3. Sets `credit_pack_applied=true` in the same transaction immediately before calling the existing finalizer.
4. The existing Batch 71 trigger mirrors the legacy purchase grant into the generation wallet and registers one verified `paid_credit_pack` revenue source.
5. A repeated webhook delegates to the original idempotent finalizer and cannot create a second grant.

The pre-Batch-80 finalizer is no longer directly executable by service-role callers; only the validating wrapper is exposed to `service_role`.

## Verification

The disposable PostgreSQL scenario verifies:
- One successful payment creates exactly one legacy credit grant.
- The same grant creates exactly one generation-wallet grant.
- Exactly one paid-credit revenue source is recorded for the exact UGX payment amount.
- Webhook replay does not duplicate either grant.
- A mismatched amount/snapshot is rejected before any grant or revenue source is written.

Node tests cover checkout snapshot creation, non-credit-pack rejection, unsnapshotted legacy replay blocking, API contracts and database privilege boundaries.

## Commercial safety

No credit-pack prices or active products are created by this batch. The existing catalogue defaults products to inactive. This batch fixes provenance and settlement correctness; provider-cost, payment-fee, support-reserve and target-margin approval remains a separate gate before any credit pack is published or sold.

No production migration, merge, deployment, live provider call, checkout activation or customer charge.
