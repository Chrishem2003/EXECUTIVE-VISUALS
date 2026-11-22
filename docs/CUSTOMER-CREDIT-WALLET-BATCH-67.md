# Batch 67 — Customer credit wallet and prepaid billing experience

**Status:** draft implementation; application type-check and CI pending.  
**Depends on:** Batch 65 verified credit-pack settlement and Batch 66 Pesapal hosted checkout.

## Customer wallet

The Billing & Subscription workspace now loads the authenticated account's authoritative credit balance from `GET /api/billing/credits`, which delegates to the existing `get_credit_balance` database RPC.

It displays:
- Ledger balance: net credit ledger position.
- Reserved: credits currently held for jobs.
- Available: credits available for eligible production.

The interface explicitly distinguishes available from reserved credits and does not store or calculate balances in browser storage.

## Server-priced top-up catalogue

The UI loads active credit packs from `GET /api/billing/products`. Product name, amount, currency and credit units are displayed from the server catalogue. The customer selects a product code; the browser does not submit a price or credit quantity.

## Hosted checkout

The new customer form calls the authenticated `POST /api/billing/credits/topup-checkout` endpoint, uses a fresh idempotency key, and redirects only to the HTTPS checkout URL returned by the server. Pesapal remains the only enabled provider in this flow.

Credits are not optimistically added to the UI. After the customer returns, the wallet must be refreshed and the verified ledger balance is authoritative.

## Constraints

- No prices or credit quantities are added or changed in this batch.
- No subscription prices or allowances are changed.
- No browser-side credit balance mutation.
- No production migrations, live payments, deployment or paid infrastructure.
- Existing API and database contracts are reused; no new database schema is required.
- Checkout remains gated by provider readiness and server-side billing configuration.

## Verification

The billing self-service workflow runs `npm run typecheck` against this branch and retains the isolated PostgreSQL checks for Batch 65 plus Batch 66 checkout/IPN tests.
