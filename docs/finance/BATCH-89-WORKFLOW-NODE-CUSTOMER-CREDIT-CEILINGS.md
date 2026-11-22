# Batch 89 — Workflow-node customer-credit ceilings

**Status:** draft implementation stacked on Batch 88 (#823).  
**Scope:** unify customer-credit approval for the workflow-canvas video node with the existing storyboard financial controls.

## Implemented

- Video Studio now displays provider credits and customer credits as separate units.
- The workflow approval panel collects an explicit integer customer-credit ceiling alongside the USD spending ceiling.
- The authenticated API calculates the required customer credits from the approved USD ceiling using the server-owned margin, payment-fee and support-reserve policy.
- An insufficient customer-credit ceiling returns HTTP 409 with the minimum required customer-credit amount; no queue request is made.
- The Neon staging workflow-node repository independently recalculates the same amount, binds it to the immutable one-shot approval snapshot and rechecks it inside the durable enqueue transaction.
- The existing Supabase workflow RPC has a new credit-ceiling-aware overload. It checks the customer-approved ceiling against the server-priced reservation amount, binds both values into the immutable job input, reserves credits in the same transaction as the provider-budget reservation and job enqueue, and verifies the reservation on idempotent replay.
- The legacy 10-argument workflow approval RPC is revoked from service-role execution so stale application code cannot bypass the new customer-credit approval contract.
- Provider/model identity remains tied to the stored quote and supports the existing Runway, Google Omni and Luma workflow quote contracts.
- Regression coverage includes insufficient ceilings, no-dispatch behavior, immutable snapshots, quote drift, idempotent replay and SQL contract checks.

## Reservation semantics

The customer credit ceiling is the owner's maximum authorized exposure. The platform reserves the server-calculated customer-credit amount for the approved USD spending ceiling; unused credit headroom is not deducted. Provider-verified usage is reconciled later by the existing settlement worker.

Provider credits are never treated as customer credits.

## Safety boundaries

- No browser-supplied credit quantity determines the actual reservation.
- No provider API is called by the approval API.
- No payment capture, subscription activation, production migration or production deployment is performed.
- The new SQL migration is source-controlled only and must be applied to disposable/staging databases through the approved migration process.
- The existing provider worker remains separately gated. This batch does not enable paid provider execution.

## Verification

The billing self-service workflow runs:
- `server/tests/neon-postgres-video-approvals.test.mjs`
- `server/tests/neon-staging-application-dispatch.test.mjs`
- `server/tests/cloud-timeline-api.test.mjs`
- `server/tests/workflow-cloud-video-bridge.test.mjs`
- `server/tests/workflow-node-customer-credit-ceiling-migration.test.mjs`

CI results are pending.
