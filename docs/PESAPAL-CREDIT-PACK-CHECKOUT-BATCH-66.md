# Batch 66 — Pesapal credit-pack hosted checkout and verified fulfillment

**Status:** draft implementation, pending CI and code review.  
**Depends on:** Batch 65 verified credit-pack purchase RPCs.  
**Provider mode:** Pesapal sandbox by default; live remains explicitly gated by existing environment controls.

## Customer flow

1. An authenticated customer submits a product code, contact details and an idempotency key to `POST /api/billing/credits/topup-checkout`.
2. The server reserves the purchase through `reserve_credit_pack_purchase`. Price, currency and credit units come exclusively from the active database product catalogue; client-supplied prices and credit quantities are ignored.
3. The server creates a Pesapal hosted checkout using the reserved UGX amount and persists the returned tracking ID and checkout URL against the pending payment.
4. A Pesapal IPN is treated only as a notification. The server looks up the matching credit-pack payment and calls Pesapal's transaction-status API through the existing adapter.
5. Only a completed transaction matching merchant reference, exact expected amount and currency reaches `finalize_credit_pack_purchase`.
6. The database RPC atomically marks the payment successful and creates the single credit grant, invoice snapshot and receipt outbox record. Duplicate notifications are safe because settlement is idempotent.

## Security and operational boundaries

- Endpoint requires the existing authenticated server route and uses the authenticated owner ID; it does not accept an owner ID from the request body.
- Payment secrets and Supabase service-role credentials remain server-side.
- Hosted checkout uses the existing Pesapal adapter and registered IPN/callback configuration.
- No browser-provided amount, currency, credit count or owner ID is trusted.
- Pending or failed provider status cannot grant credits.
- The existing Paddle and Flutterwave flows are unchanged. This batch wires Pesapal only; a separate Flutterwave checkout adapter remains future work.
- The provider readiness gate and explicit live-mode flag remain in force.
- No production migrations, live payments, product activation, deployment or paid infrastructure.

## Tests

`server/tests/credit-pack-topup-checkout.test.mjs` covers:
- server-reserved UGX amount and credit quantity flowing into hosted checkout;
- checkout URL and provider tracking ID persistence;
- idempotent checkout replay without creating a second provider checkout;
- Pesapal IPN verification with exact expected amount and currency;
- forwarding only verified transaction evidence to the finalization RPC.

The billing CI workflow also applies the Batch 65 migration and PostgreSQL integration test in its disposable database before running the Batch 66 application tests.
