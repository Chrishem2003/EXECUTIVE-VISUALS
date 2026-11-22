# Batch 47 — Smart Generation Credit Preflight

**Status:** implemented on a feature branch; CI and staging migration verification pending.  
**Date:** 2026-11-22  
**Scope:** read-only affordability preview before an explicitly approved workflow quote. No credit reservation, payment, provider execution or production migration.

## Delivered

- Added `get_generation_credit_balance_for_project(owner, project)` as a service-role-only Supabase RPC.
- The RPC follows the same funding-source selection as the existing atomic `reserve_generation_credits` RPC:
  - if the project has a shared credit pool, report that pool's ledger balance and active reservations;
  - otherwise, report the owner's personal generation wallet.
- The RPC checks project ownership and rejects cross-owner pool access.
- Cloud video quote creation now reads the project-scoped wallet and returns an advisory `creditAvailability` object:
  - `status`: `sufficient`, `insufficient`, `suspended` or `unavailable`;
  - `requiredCredits`, `availableCredits`, `reservedCredits`, `ledgerBalance`;
  - `fundingSource` and `poolStatus`;
  - `canCoverQuote`.
- An unavailable balance read does not silently become zero and does not prevent a non-billable quote from being displayed. It is explicitly marked `unavailable`.
- Quote creation remains non-billable and the existing approval/enqueue RPC remains the only authority for atomic credit reservation. A displayed sufficient balance is not a guarantee; concurrent jobs may consume credits before approval.

## Accounting details

Both wallet implementations record reservations as debits from the available balance:
- personal wallet: available = sum of `billing_credit_ledger.amount`; reserved is reported separately from active `billing_credit_reservations`;
- project pool: available = sum of `project_credit_pool_ledger.amount`; reserved is reported separately from active `project_credit_pool_reservations`.

The response reports gross ledger balance as available plus active reservations, so the identity is always `ledgerBalance = availableCredits + reservedCredits`.

## Verification

- Added quote API tests for sufficient personal wallet, exact-fit project pool, insufficient project pool, suspended pool and unavailable balance service.
- Added migration/API contract tests for ownership checks, service-role-only execution and use of the same wallet as the reservation path.
- The API never reserves credits during quote preview; approval continues to reserve atomically with job enqueue.

## Release gates

- Migration is additive and must be exercised in disposable PostgreSQL CI/staging before production consideration.
- No production database migration was applied.
- No payment provider was called.
- No customer credits were granted, reserved, settled or released.
- No provider request was submitted.
- No merge or deployment was performed.

## Next

Connect the quote's affordability object to the workflow approval panel, refresh the balance when the customer opens the approval step, and display a clear top-up/insufficient-credit state. Keep the server-side atomic approval check authoritative regardless of the UI state.
