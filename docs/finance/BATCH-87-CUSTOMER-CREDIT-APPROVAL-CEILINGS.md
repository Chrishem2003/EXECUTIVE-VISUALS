# Batch 87 — Customer-credit approval ceilings

**Status:** draft implementation stacked on Batch 86 (#821).  
**Purpose:** bind the server-calculated customer-credit quote to the user's explicit production approval and spending ceiling.

## Change

- The production approval route now recalculates a fresh server-side provider preflight and customer-credit quote.
- Approval fails closed when customer-credit pricing is unconfigured, the per-shot quote is incomplete, or USD cost cannot be represented safely.
- The approval request must include an explicit positive `customerCreditBudgetCredits` ceiling.
- The ceiling must be at least the server-calculated total customer credits.
- Per-shot credit entries must match the approved shot order and sum exactly to the aggregate.
- The immutable approval snapshot and request hash include the customer-credit quote and ceiling, so idempotency cannot replay a different spending limit.
- Approval responses return both USD quote/budget and customer-credit quote/ceiling.

## Safety boundaries

This is a budget-approval snapshot only. It does not reserve, deduct, grant or refund credits, create a generation job, or submit provider work. Submission remains disabled until the separate atomic reservation and authoritative provider-usage settlement path is available. No live provider calls, migrations, payments or deployment occur.

## Regression coverage

Unit tests cover exact quote binding, required explicit ceiling, under-budget rejection, and per-shot/aggregate integrity. Existing USD quote and idempotency semantics remain intact.
