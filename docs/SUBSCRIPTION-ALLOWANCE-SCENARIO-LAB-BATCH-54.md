# Batch 54 — Subscription allowance scenario lab

**Status:** implemented as a read-only finance-admin scenario; exact-head CI pending.  
**Date:** 2026-11-22  
**Scope:** connect the existing subscription allowance calculator to the Financial Command Centre without publishing customer allowances or changing billing.

## Delivered

- Added `POST /api/admin/finance/subscription-allowance-simulation`, restricted to finance administrators.
- Added a Financial Command Centre panel for target gross margin, payment fee, refund reserve, fixed payment fee, support reserve and infrastructure reserve assumptions.
- Uses the existing `simulateSubscriptionAllowances` engine and the proposed $9 / $29 / $79 / $199 test plans.
- Displays provider-cost budgets after the entered assumptions.
- Does not accept caller-supplied provider-cost-per-credit or approval evidence. The API rejects those fields; measured cost evidence must originate from trusted invoice reconciliation.
- The simulator returns no included-credit allowance when verified evidence is absent and marks every result `publishable: false`.

## Financial and security boundaries

- All monetary assumptions use integer USD cents; percentage assumptions use basis points.
- The interface defaults are illustrative scenario inputs only and can be changed by the finance administrator.
- This is not a provider quote, actual cost, invoice, payment, customer credit allowance or approved plan configuration.
- The endpoint performs no database writes and does not invoke providers, reserve credits, change subscriptions, or update the plan catalogue.
- Customer credit quantities remain unpublished until measured provider-cost evidence and separate product/finance approval exist.

## Verification

- API tests cover finance-admin authorization, no database write, no allowance publication without measured evidence, and rejection of client-forged cost evidence.
- Financial intelligence tests and application build must pass on the exact PR head before promotion.

## Release safety

No migrations, provider credentials, live checkout, customer charges, production configuration, merges or deployments are included.
