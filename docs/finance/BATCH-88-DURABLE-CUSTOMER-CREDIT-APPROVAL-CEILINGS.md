# Batch 88 — Durable customer-credit approval ceilings

**Status:** draft implementation stacked on Batch 87 (#822).  
**Purpose:** ensure the customer-approved credit quote and maximum credit spend survive the local-to-Neon approval handoff and are enforced inside the same transaction that queues production jobs.

## Implemented

- The immutable storyboard approval snapshot carries the exact per-shot customer-credit quote and the explicit customer-credit ceiling.
- Neon approval registration validates that every credit entry maps to the exact approved shot, that per-shot credits sum to the quoted total, and that the ceiling is a positive bounded integer at least as large as the quote.
- At durable enqueue, the server recalculates each shot's customer-credit amount from the approved provider-cost ceiling using the server-owned policy.
- The recomputed amount must exactly match the immutable customer-approved per-shot quote. Persisted reservations must also match it.
- The aggregate reservation must reconcile exactly to the approved quote and remain below the approved credit ceiling.
- All shots remain inside one PostgreSQL transaction. A quote mismatch or ceiling violation rolls back every shot enqueue and leaves the local approval pending.
- Stale credit quotes and insufficient approved credit ceilings return HTTP 409 conflicts rather than generic provider failures.
- Regression tests cover snapshot validation, quote drift, transaction rollback, dispatch preservation and the exact approval handoff.

## Existing ledger boundary

This reuses the existing PostgreSQL `enqueue_video_generation_job_v1` and `reserve_generation_credits` transaction path. It does not introduce a duplicate wallet, duplicate reservation ledger or a second payment-to-credit mirror.

## Safety boundaries

- No credits are reserved until the existing durable enqueue transaction executes.
- No browser-supplied credit amount is used as the reservation amount.
- No provider task is submitted by the API; provider execution remains controlled by the separately gated staging worker.
- No payment capture, subscription activation, production database migration, production deployment or provider credential change is performed.
- The separate workflow-node approval path retains its existing quote-bound dispatch contract; explicit credit ceilings for that separate path remain a follow-on integration item.

## Verification

The billing self-service workflow now runs `server/tests/neon-postgres-video-approvals.test.mjs` and `server/tests/neon-staging-application-dispatch.test.mjs`.

CI results are pending.
