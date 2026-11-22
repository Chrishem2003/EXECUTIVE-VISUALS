# Batch 65 — Verified one-time credit-pack top-ups

**Status:** draft implementation, pending isolated PostgreSQL CI and review.  
**Base:** Batch 64 approved-credit settlement safeguard.  
**Payment activation:** disabled; no production provider calls or charges.

## Scope

Adds a server-owned credit-pack purchase reservation and fulfillment path for the existing UGX credit-pack catalogue. Flutterwave and Pesapal are supported by the database contract. The purchase amount and credit entitlement are read from the active product row; neither is accepted from the browser.

## Transaction rules

1. The authenticated owner, active product, provider, email and idempotency key are validated server-side.
2. A per-owner transaction lock serializes purchase reservation and prevents conflicting retries.
3. The payment row snapshots product code, amount/currency, credit units and idempotency key.
4. Reusing the same idempotency key returns the same pending/successful payment; using it for a different provider or product is rejected.
5. The service role may finalize only a verified provider payment whose amount, currency, merchant reference and provider transaction ID match the reservation.
6. Successful fulfillment creates one immutable purchase-grant ledger entry, one invoice snapshot and one deduplicated receipt-outbox event.
7. Duplicate settlement returns the existing successful result without granting credits again.
8. Mismatched or unverified payment evidence cannot change payment state or grant credits.

## Deliberate constraints

- The existing catalogue is UGX-only. This batch therefore supports Flutterwave and Pesapal, not Paddle USD credit packs.
- It does not activate any product, invent top-up prices or credit quantities, create a provider checkout session, or enable live payment credentials.
- Provider checkout orchestration and customer billing UI remain separate follow-up work.
- All PostgreSQL tests run against the disposable billing CI database.
- No production migration, paid infrastructure or deployment is performed.

## Acceptance coverage

scripts/verified-credit-pack-topups-postgres-integration.sql verifies server-owned product amount and credit units; idempotent reservation replay; rejection of a mismatched provider amount without state mutation or credit grant; successful verified grant and invoice creation; deduplicated receipt outbox; and idempotent successful settlement replay.
