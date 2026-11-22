# Batch 64 — Customer wallet reservation and actual-usage settlement

**Status:** implementation contract / review draft.  
**Base:** Batch 63 customer-facing provider-cost and credit quote.  
**Release state:** no wallet mutation, provider dispatch, payment activation, migration application or deployment.

## Objective

Turn the forecast shown before generation into a safe, customer-authorized credit transaction. The customer quote is advisory until the customer approves it; approval must bind the exact quote and immutable shot list, reserve credits atomically, and prevent a provider worker from running without that reservation.

This batch is deliberately separate from subscription payment and monthly allowance publication. Those grant credits only after a verified payment or a separately approved allowance publication. A forecast must never grant or spend credits.

## Existing contracts to preserve

- Batch 61 produces a USD provider-cost forecast and a server-calculated customer-credit quote. It is forecast-only and does not reserve credits.
- Batch 62 rejects resolution tiers not explicitly attested by a governed rate card.
- Batch 63 displays total and per-shot provider cost/customer credits before approval, matching by stable shot ID.
- The existing video-production approval flow binds the exact shot quote, owner/project, currency, budget ceiling and idempotency key. Cloud dispatch and worker execution are separately gated.
- Existing project credit pools and personal wallets must remain isolated. The project-scoped preflight is advisory; the database reservation transaction is authoritative.

## Required transaction

1. Re-authenticate the owner/editor and re-check active project membership inside the database transaction.
2. Recompute the current provider quote server-side from the exact active rate-card version; reject changed, expired, unsupported or unavailable pricing.
3. Bind quote ID/hash, provider/model, resolution, duration, per-shot amounts, currency, policy version, owner, project and idempotency key into an immutable approval snapshot.
4. Atomically lock the selected funding source (project pool when configured, otherwise personal wallet), verify available balance after active reservations, and create one reservation for the exact aggregate approved credits.
5. Create one durable task per approved shot and link every task to the same approval and reservation. Enforce that per-shot credit amounts sum exactly to the aggregate reservation.
6. Only then allow the separately gated worker to submit the provider task. Persist the provider task ID before polling; ambiguous submissions stay in state submission_unknown and must be reconciled, never blindly resubmitted.
7. On verified completion, reconcile actual provider usage against the reservation. Capture the server-calculated final customer credits and release any unused reservation in one idempotent transaction.
8. On confirmed provider-side terminal failure, release the reservation exactly once. Moderation charges, customer cancellation, provider-side failure and uncertain outcomes must follow the provider's documented billing semantics; do not assume every failed task is free.
9. Append immutable financial audit events for reserve, capture, release and adjustment. Preserve the original quote and actual invoice/usage evidence.

## Required states

- Approval: pending → reserved → submitted → settled; or released; or reconciliation_required.
- Reservation: reserved → captured (actual charge) + released (unused remainder); or released (no charge).
- Provider task: queued → submitting → submitted → succeeded / failed; ambiguous outcomes use submission_unknown.

Terminal transitions must be idempotent. A duplicate webhook, worker retry, queue replay or browser retry must not double-reserve, double-capture, double-release or double-charge.

## Acceptance tests

- Personal wallet and project-pool reservation both select the correct funding source.
- Insufficient balance, archived project, revoked membership, stale quote, changed rate card and quote-over-budget all block before enqueue.
- Concurrent approvals cannot overspend the same wallet or project pool.
- Duplicate approval and worker delivery return the same durable result.
- Per-shot amounts must sum exactly to the aggregate reservation.
- No provider task is submitted before the reservation commits.
- Provider task ID persistence and submission_unknown recovery prevent duplicate POSTs.
- Actual usage greater than the approved ceiling requires a new explicit customer approval; it must never silently overdraw.
- Actual usage below the reservation captures only the verified charge and releases the remainder.
- Confirmed terminal failure releases once; uncertain or moderation-billed outcomes remain held for reconciliation.
- Every ledger mutation has an immutable audit event and source evidence.
- Customer-visible history distinguishes forecast, reserved, captured, released and adjusted credits.

## Non-goals and release gates

- Do not publish the proposed $9 / $29 / $79 / $199 plan prices or invent monthly credit allowances.
- Do not grant credits from an unverified payment, browser-supplied amount, forecast, or duplicate webhook.
- Do not enable live checkout, paid generation, production migrations or production deployment.
- Do not change existing provider credentials, Render services, paid infrastructure or production configuration.
- Keep all database integration tests on disposable PostgreSQL and all provider calls mocked.
- Keep worker dispatch disabled until the migration, API, concurrency tests and isolated staging acceptance pass.

## Current provider-cost evidence to use in fixtures, not as a production fallback

Runway Dev's published pricing page reports Seedance 2.5 at $0.20/sec (480p), $0.30/sec (720p) and $0.68/sec (1080p), with a minimum $0.80 generation charge and additional per-second video-reference costs. A 5-second text-prompt generation therefore costs $1.00 / $1.50 / $3.40 before reference-video charges. These values are dated evidence, not hard-coded application prices; the immutable production rate card must be registered from a current source and reconciled against actual invoices.

Source: https://dev.runwayml.com/pricing (checked 2026-11-22; Runway Dev lists 1 credit = $0.01).
