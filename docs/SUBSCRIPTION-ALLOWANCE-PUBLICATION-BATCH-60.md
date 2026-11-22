# Batch 60 — Audited subscription allowance publication

**Status:** implementation and disposable PostgreSQL verification in progress.  
**Release state:** draft review only; no live provider checkout, payment collection or customer credit grants.

## Publication contract

Batch 59 persists the exact invoice-backed allowance proposal and the independent finance/product decisions. Batch 60 adds a separate publication command.

The publication transaction:
1. Authenticates an `owner` or `platform_admin` again inside PostgreSQL.
2. Rechecks the exact proposal hash and source plan version.
3. Requires both approved decision rows, the expected finance/product roles and distinct approvers.
4. Requires the publisher to be distinct from the proposal creator and both approvers.
5. Locks the plan and requires the exact version to remain draft, private and unchanged in name, currency and proposed monthly price.
6. Refuses publication if an active provider price is already attached and therefore needs separate review.
7. Appends `subscription_allowance.published` to the financial hash-chain and atomically publishes the catalogue plan, the approved included-credit allowance and a new plan version.
8. Writes an immutable publication record linking the proposal, hash, plan versions, two approval records and audit event.

## API

`POST /api/admin/finance/subscription-allowance-proposals/:id/publish`

Request body contains only:
- `proposalHash`: exact 64-character SHA-256 proposal hash.
- `planVersion`: exact source draft version.

The request requires an 8–160 character idempotency key in the request header. Browser-supplied roles, approval records, prices, provider costs, plan entitlements or credit quantities are rejected.

## Explicit boundaries

Publication makes the approved plan visible in the public subscription catalogue. It does **not**:
- configure Paddle or Pesapal provider prices;
- enable checkout or create a provider product;
- collect a payment;
- create a customer subscription;
- grant customer credits or reset a wallet;
- change existing customer entitlements.

Provider price setup and verified-payment-to-credit grant are separate gated operations. The API returns `checkoutEnabled: false` and `creditsGranted: false`.

## Verification

- API tests cover independent publisher role, exact proposal hash/version, audit payload, and rejection before publication when dual approval is incomplete.
- Disposable PostgreSQL integration applies the Batch 59 and Batch 60 migrations, performs finance and product approvals, publishes the exact draft as a separate owner, verifies the plan version and credit allowance, checks no checkout/credits are activated, verifies idempotent replay and rejects mutation of the immutable publication record.
